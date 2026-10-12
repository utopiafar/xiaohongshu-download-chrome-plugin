/** 小红书笔记下载器 - Service Worker: CDN 抓取、下载状态与安全落盘。 */
'use strict';

const pendingNames = new Map();
const ownedDownloadIds = new Set();
const mediaTransfers = new Map();
const PENDING_LIMIT = 32;
const MEDIA_HOST_RE = /(^|\.)(xhscdn|rednotecdn)\.com$/;
const SITE_HOST_RE = /(^|\.)xiaohongshu\.com$/;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MEDIA_MAX_BYTES = 256 * 1024 * 1024;
const MEDIA_INLINE_BYTES = 8 * 1024 * 1024;
const MEDIA_CHUNK_BYTES = 1024 * 1024;
const TRANSFER_TTL_MS = 120000;
const MESSAGE_TYPES = new Set([
  'fetch-image', 'fetch-media', 'fetch-media-chunk', 'release-media',
  'download', 'download-state', 'query-path', 'show-in-folder', 'open-folder-tab',
]);

class RequestError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function fail(error) {
  return { ok: false, error: error?.message || '操作失败', errorCode: error?.code || 'REQUEST_FAILED' };
}

function contentSender(sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id)) {
    throw new RequestError('请求不是来自本插件的网页脚本', 'INVALID_SENDER');
  }
  let url;
  try { url = new URL(sender.url); } catch (_) {
    throw new RequestError('无效的网页来源', 'INVALID_SENDER');
  }
  if (!['https:', 'http:'].includes(url.protocol) || !SITE_HOST_RE.test(url.hostname) || url.username || url.password) {
    throw new RequestError('请求来源不是小红书网页', 'INVALID_SENDER');
  }
  return { origin: url.origin, key: `${sender.tab.id}:${sender.frameId ?? 0}:${url.origin}` };
}

function mediaUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) {
    throw new RequestError('无效的素材地址', 'INVALID_URL');
  }
  if (typeof value !== 'string' || url.protocol !== 'https:' || !MEDIA_HOST_RE.test(url.hostname) ||
      url.username || url.password || (url.port && url.port !== '443')) {
    throw new RequestError('素材地址不在支持的 CDN 域名内', 'INVALID_URL');
  }
  return url.href;
}

function safeFilename(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 ||
      /[\\<>:"|?*\x00-\x1f\x7f]/.test(value)) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** 在读取流时限制大小，避免先把超大响应完整分配到内存。 */
async function limitedBytes(response, limit) {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new RequestError(`素材超过 ${limit / 1024 / 1024}MB`, 'SIZE_LIMIT');
  }
  if (!response.body) throw new RequestError('素材内容为空', 'EMPTY_CONTENT');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new RequestError(`素材超过 ${limit / 1024 / 1024}MB`, 'SIZE_LIMIT');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new RequestError('素材内容为空', 'EMPTY_CONTENT');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchMedia(value, imageOnly) {
  const url = mediaUrl(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), imageOnly ? 15000 : 60000);
  try {
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new RequestError(`HTTP ${response.status}`, 'HTTP_ERROR');
    const contentType = response.headers.get('content-type') || '';
    if (/^(?:text\/|application\/(?:json|xml|javascript))/i.test(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new RequestError('CDN 返回了网页或文本而非素材', 'CONTENT_TYPE');
    }
    const bytes = await limitedBytes(response, imageOnly ? IMAGE_MAX_BYTES : MEDIA_MAX_BYTES);
    const prefix = new TextDecoder().decode(bytes.subarray(0, 128)).trimStart();
    if (/^(?:<!doctype\s+html|<html\b|<\?xml|[\[{])/i.test(prefix)) {
      throw new RequestError('CDN 返回了错误文本而非素材', 'CONTENT_TYPE');
    }
    return { bytes, contentType };
  } catch (error) {
    if (controller.signal.aborted) throw new RequestError('素材下载超时', 'TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function cleanTransfers() {
  const now = Date.now();
  for (const [id, transfer] of mediaTransfers) {
    if (transfer.expiresAt <= now) mediaTransfers.delete(id);
  }
}

function storeTransfer(bytes, owner) {
  cleanTransfers();
  let total = [...mediaTransfers.values()].reduce((sum, item) => sum + item.bytes.byteLength, 0);
  while (mediaTransfers.size && (mediaTransfers.size >= 3 || total + bytes.byteLength > MEDIA_MAX_BYTES)) {
    const id = mediaTransfers.keys().next().value;
    total -= mediaTransfers.get(id).bytes.byteLength;
    mediaTransfers.delete(id);
  }
  const transferId = crypto.randomUUID();
  mediaTransfers.set(transferId, { bytes, owner, expiresAt: Date.now() + TRANSFER_TTL_MS });
  return transferId;
}

function readTransfer(id, owner) {
  cleanTransfers();
  const transfer = typeof id === 'string' && mediaTransfers.get(id);
  if (!transfer || transfer.owner !== owner) throw new RequestError('素材传输已过期或来源不匹配', 'TRANSFER_EXPIRED');
  transfer.expiresAt = Date.now() + TRANSFER_TTL_MS;
  return transfer;
}

function ownDownload(id) {
  if (!Number.isInteger(id) || id < 0) return Promise.reject(new RequestError('无效的下载 ID', 'INVALID_DOWNLOAD'));
  return new Promise((resolve, reject) => {
    chrome.downloads.search({ id }, (items) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new RequestError(error.message, 'DOWNLOAD_ERROR'));
      const item = items?.[0];
      if (!item || (item.byExtensionId !== chrome.runtime.id && !ownedDownloadIds.has(id))) {
        return reject(new RequestError('未找到本插件的下载记录', 'INVALID_DOWNLOAD'));
      }
      resolve(item);
    });
  });
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const target = pendingNames.get(item.url);
  if (target && (!item.byExtensionId || item.byExtensionId === chrome.runtime.id)) {
    pendingNames.delete(item.url);
    suggest({ filename: target, conflictAction: 'uniquify' });
  } else {
    suggest();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !MESSAGE_TYPES.has(msg.type)) return false;
  let source;
  try { source = contentSender(sender); } catch (error) {
    sendResponse(fail(error));
    return false;
  }
  (async () => {
    if (msg.type === 'fetch-image' || msg.type === 'fetch-media') {
      const imageOnly = msg.type === 'fetch-image';
      const { bytes, contentType } = await fetchMedia(msg.url, imageOnly);
      if (imageOnly || bytes.byteLength <= MEDIA_INLINE_BYTES) {
        return { ok: true, b64: bytesToBase64(bytes), byteLength: bytes.byteLength, contentType };
      }
      return { ok: true, transferId: storeTransfer(bytes, source.key), byteLength: bytes.byteLength,
        chunkBytes: MEDIA_CHUNK_BYTES, contentType };
    }
    if (msg.type === 'fetch-media-chunk') {
      const transfer = readTransfer(msg.transferId, source.key);
      if (!Number.isInteger(msg.offset) || msg.offset < 0 || msg.offset >= transfer.bytes.byteLength) {
        throw new RequestError('无效的素材分块偏移', 'INVALID_OFFSET');
      }
      const nextOffset = Math.min(msg.offset + MEDIA_CHUNK_BYTES, transfer.bytes.byteLength);
      return { ok: true, b64: bytesToBase64(transfer.bytes.subarray(msg.offset, nextOffset)),
        nextOffset, done: nextOffset === transfer.bytes.byteLength };
    }
    if (msg.type === 'release-media') {
      readTransfer(msg.transferId, source.key);
      mediaTransfers.delete(msg.transferId);
      return { ok: true };
    }
    if (msg.type === 'download') {
      let url;
      try { url = new URL(msg.url); } catch (_) {
        throw new RequestError('无效的下载地址', 'INVALID_URL');
      }
      if (typeof msg.url !== 'string' || url.protocol !== 'blob:' || url.origin !== source.origin) {
        throw new RequestError('仅支持当前小红书网页生成的 blob 文件', 'INVALID_URL');
      }
      if (!safeFilename(msg.filename)) throw new RequestError('保存路径必须是安全的相对路径', 'INVALID_FILENAME');
      if (pendingNames.size >= PENDING_LIMIT) pendingNames.delete(pendingNames.keys().next().value);
      pendingNames.set(msg.url, msg.filename);
      try {
        const downloadId = await new Promise((resolve, reject) => {
          chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false, conflictAction: 'uniquify' }, (id) => {
            const error = chrome.runtime.lastError;
            if (error || !Number.isInteger(id)) reject(new RequestError(error?.message || '无法创建下载任务', 'DOWNLOAD_ERROR'));
            else resolve(id);
          });
        });
        ownedDownloadIds.add(downloadId);
        // Chrome 的 byExtensionId 也可在 SW 重启后确认归属；内存集合仅为兼容兜底。
        if (ownedDownloadIds.size > 512) ownedDownloadIds.delete(ownedDownloadIds.values().next().value);
        return { ok: true, downloadId };
      } catch (error) {
        pendingNames.delete(msg.url);
        throw error;
      }
    }
    if (msg.type === 'download-state' || msg.type === 'query-path') {
      const item = await ownDownload(msg.downloadId);
      if (msg.type === 'query-path') return { ok: !!item.filename, path: item.filename || null };
      return { ok: true, state: item.state, error: item.error || null, path: item.filename || null, exists: item.exists !== false };
    }
    if (msg.type === 'show-in-folder') {
      const item = await ownDownload(msg.downloadId);
      if (item.exists === false) throw new RequestError('下载文件已被删除或移动', 'FILE_MISSING');
      await chrome.downloads.show(msg.downloadId);
      return { ok: true };
    }
    if (msg.type === 'open-folder-tab') {
      if (typeof msg.path !== 'string' || !msg.path || /[\x00-\x1f]/.test(msg.path) ||
          !/^(?:\/|[a-z]:[\\/])/i.test(msg.path)) {
        throw new RequestError('无效的本地目录路径', 'INVALID_PATH');
      }
      let path = msg.path.replace(/\\/g, '/');
      if (!path.startsWith('/')) path = `/${path}`;
      const url = new URL('file:///');
      url.pathname = path.replace(/%/g, '%25');
      await new Promise((resolve, reject) => {
        chrome.tabs.create({ url: url.href }, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new RequestError(error.message, 'OPEN_FOLDER_ERROR'));
          else resolve();
        });
      });
      return { ok: true };
    }
  })().then(sendResponse, (error) => sendResponse(fail(error)));
  return true;
});

# 小红书笔记下载器(Chrome 插件)

一个专注于「下载小红书笔记」的 Chrome 扩展,无任何第三方依赖,不需要 API Key。

## 功能

| 场景 | 操作 |
| --- | --- |
| 打开某篇笔记(`/explore/xxx` 等) | 「⬇ 下载笔记」保存笔记和媒体；「⬇ 保存笔记＋评论」同时保存评论及回复。空间不足时按钮显示在右下角 |
| 打开博主主页(`/user/profile/xxx`) | 页面右下角出现「⬇ 下载该博主全部笔记」按钮,点击后自动滚动收集全部笔记并逐篇下载 |

下载完成后,进度面板会显示**完整保存路径**,主按钮自动变为「📂 打开目录」,一键在系统文件管理器(macOS Finder / Windows 资源管理器)中定位到文件(面板通过右上角 × 关闭)。

每篇笔记打包为**一个 zip**,命名:`xiaohongshu-笔记标题-发布日期.zip`(如 `xiaohongshu-你好-20260930.zip`),内容:

```
xiaohongshu-你好-20260930.zip
├── 你好.md            # 笔记内容(markdown):标题/博主/时间/标签/正文,图片按相对路径引用
├── images/
│   ├── 01.jpg         # 图片笔记:全部图片(CDN 的 webp/avif 已自动转为 jpg,双击即开)
│   └── cover.jpg      # 视频笔记:封面
└── video.mp4          # 视频笔记:视频
```

保存位置(位于浏览器默认下载目录下):

```
小红书下载/
└── 博主昵称/
    ├── 001_xiaohongshu-你好-20260930.zip   # 批量下载带序号前缀,保持笔记顺序
    └── 002_xiaohongshu-世界-20260928.zip
```

单篇下载时 zip 直接放在博主文件夹下,没有序号前缀。markdown 里图片/视频用相对路径引用,在 Typora、Obsidian 等编辑器中打开 `.md` 即可图文混排。

## 保存笔记＋评论（v1.4.0）

点击新增按钮后，插件读取当前已打开的笔记，自动滚动评论区域，并逐次展开回复。沿用网页自身的加载逻辑，无需 API Key 或额外登录授权。收集结束后恢复评论区原来的滚动位置。

```
xiaohongshu-标题-发布日期-含评论.zip
├── 笔记.md            # 图文正文，附评论文件链接和媒体失败说明
├── 笔记.json          # 笔记元数据和媒体来源
├── 评论.md            # 主评论与回复层级，昵称、时间、点赞数、地区
├── 评论.json          # schemaVersion=1，评论 ID、parentId、replyTo 与嵌套 replies
├── images/            # 笔记图片或视频封面
└── video.mp4          # 视频笔记
```

`评论.json` 同时记录 `exportedAt`、`reportedTotal`、`complete` 和 `reason`，便于判断归档范围；已加载评论与回复按 ID 去重。评论中的图片保留在线链接，不下载头像和评论图片。

只保存当前账号通过网页可以加载的内容；被删除、隐藏或后续新增的评论不会包含在归档中。遇到加载停滞、未展开回复，或达到单次 3 分钟 / 10000 条的收集上限时，会保存已取得的评论并明确标注“部分保存”。点击“取消下载”停止本次任务；离开原笔记会停止评论收集，避免保存其他笔记的评论。批量博主下载仍只保存笔记和媒体。

## 安装

1. 打开 Chrome,访问 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」,选择本目录(包含 `manifest.json` 的文件夹)
4. 打开 [www.xiaohongshu.com](https://www.xiaohongshu.com) 并**登录**,即可使用

## 工作原理

- 单篇优先通过 MAIN world 读取当前页面已加载的笔记状态；批量下载或页面状态不可用时，通过同源 `fetch` 请求笔记 HTML（自动携带登录 Cookie 和 `xsec_token`）
- 安全解析 `window.__INITIAL_STATE__`，兼容新版 `new Map([])` / `new Set([])`、裸 `undefined` 和 Vue ref；严格匹配笔记 ID，避免导出其他缓存笔记。解析不执行网页脚本
- 批量下载时,逐篇笔记的 `xsec_token` 由注入页面 JS 环境的 `main.js` 从页面 state 读取回传(2024 年后小红书笔记链接必须带 token 才能访问)
- 图片和视频通过后台 Service Worker 抓取官方 CDN（保持原有 `xhscdn.com` / `rednotecdn.com` 权限）。图片限制 20MB / 15 秒，视频限制 256MB / 60 秒；大视频分块传回，CDN 的网页/JSON 错误不会当媒体保存。webp/avif 自动转为 jpg
- 抓取到的媒体用内置的 `zip.js`(纯原生 ZIP/STORE 实现,无第三方库)打包成单个 zip
- zip 的 blob URL 交给后台 `chrome.downloads` 落盘,并经 `onDeterminingFilename` 改名到「小红书下载/博主/」子目录(Chrome 会忽略跨上下文 blob URL 的 filename 参数;失败时自动降级为浏览器直接下载)
- 下载面板等待 Chrome 确认文件保存完成，下载中断会显示失败；批量下载滚动收集主页笔记，逐篇处理，可随时取消

环境要求:Chrome 111+(需要 manifest 中的 MAIN world 注入能力)。

## 注意事项

- **需要登录**小红书网页版,否则拿不到笔记数据
- 批量收集笔记阶段会**自动滚动页面**,请保持该标签页在前台(后台标签页会被浏览器限速)
- 笔记之间有约 0.6~1 秒的间隔(防止触发风控),大博主下载耗时较长属正常现象
- 出现少量失败(如删除/仅自己可见的笔记)会在日志面板中标注,不影响其余笔记
- 隐私:所有数据只在本地浏览器内处理,不上传任何服务器
- 请仅用于个人备份,尊重原作者版权,勿用于二次分发

## 文件结构

```
manifest.json   # 插件清单(MV3)
background.js   # Service Worker,负责调用 chrome.downloads 落盘
main.js         # MAIN world 只读桥:当前笔记、评论加载状态和主页笔记列表
data.js         # 共享安全状态解析、数据适配、评论去重与 Markdown 导出
zip.js          # 纯原生 ZIP 打包(STORE 不压缩 + CRC32,支持中文文件名)
content.js      # 内容脚本:按钮/进度 UI、笔记数据解析、批量收集与下载流程
content.css     # 注入页面的 UI 样式
```

## 开发验证

无需安装测试依赖，使用 Node.js 20+：

```sh
node --test tests/*.test.js
```

测试覆盖新版状态序列化、Vue ref、准确选择笔记、评论层级与去重、媒体下载限制与分块、下载状态、取消和 ZIP 条目。修改后在 `chrome://extensions/` 点击本扩展的“重新加载”，再刷新小红书标签页。

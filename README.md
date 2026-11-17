# 靠北Chat（KBChat）

网页版多人在线实时聊天。**正式入口：<https://kbchat.pages.dev>**（Cloudflare Pages，后端 API 也在同域）。

本仓库 `https://k-dji.github.io/kbchat/` 是入口镜像：`index.html` 全屏内嵌正式站点（GitHub Pages 为纯静态托管，聊天后端无法在此运行，故跳转到 Cloudflare 承载的完整应用）。

- `site/` — 站点完整源码备份（index.html / _worker.js 后端 / css / js / assets / 安卓安装包）
- 安卓 App：正式签名版 APK 随站点分发：`https://kbchat.pages.dev/kbchat.apk`

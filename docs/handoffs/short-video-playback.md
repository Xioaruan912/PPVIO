# 短视频播放与参考方向

用户确认：91 是 PPVIO 整个产品的长期参考，包括功能和交互，不限于缓冲。这一轮只实现播放、预加载和资源生命周期；其他功能后续逐项评估，不因此扩大当前改动。

## 这一轮

- 保留当前与相邻共最多三个 video；只有下一条可升级为 auto 预加载。
- 参考 91 的高低水位：当前视频缓冲达到码率调整后的 4–12 秒才放行下一条，低于 max(1.5 秒, 高水位/3) 后收回，避免反复切换。
- 使用播放点所在的连续缓冲区，并考虑倍速。短片已缓冲到尾部可提前放行。
- 低清副本缺少自身大小，不能套用原画码率；这时使用 12 秒门槛。
- 暂停、隐私锁、后台、卡顿时降级预载。预加载是浏览器提示，不能承诺严格带宽/字节上限。
- 视频离开挂载窗口时暂停并释放源；兼容 StrictMode 重复挂载，忽略过期播放请求的失败。
- 移动 Chromium 实测可能在 metadata 加载后停下；第一次升级下一条为 auto 且缓冲不足两秒时显式 load 一次，后续水位波动保留已有缓冲。
- 未调整服务器缓存预算、数据库、网盘协议或生产容器。

## 参考来源

下面是独立实现所参考的策略，没有直接复制整套播放器：

- [91 / mediaBuffer](https://github.com/nianzhibai/91/blob/fcb13d5ba0f84308e704a0ced59d8fc22fe66134/src/shorts/mediaBuffer.ts)：MIT，缓冲高低水位、码率与预载授权。该项目 README 不推荐 iOS 短视频模式；移动端须独立验证。
- [OpenTok / VideoPool](https://github.com/caixax/opentok/blob/2e0544003945c59016ed7b74c4575bd063774d13/src/renderer/video/VideoPool.ts)：MIT，三个播放器、下一条预载、旧资源释放。
- [TikLocal / flow](https://github.com/ChanMo/TikLocal/blob/f9d1328d2311c65cbbc95e9ab61fee2cca21b436/tiklocal/static/flow_page_controller.js)：MIT，首帧数据就绪判定。
- [Erin / VideoFeed](https://github.com/will-moss/erin/blob/93328eea7553a1572cbf199fd3f03735d784cfd4/src/components/VideoFeed/index.jsx)：MIT，固定卡片循环复用与清理。

后续以 91 为主要参考，逐项研究多网盘、播放读取路径、短视频交互和分享等功能，保留 PPVIO 现有认证、数据格式和发布边界。

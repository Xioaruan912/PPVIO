# 后端局部约定

继承根AGENTS.md；本文件约束src/ppvio。

- 独立项目：不 import TGVIO，不访问 TGVIO Bot 的运行数据或 Telegram 凭据；两者只通过网盘目录交接。
- Catalog只读取有效manifest + _COMPLETE，不下载全片或常规重新ffprobe建库。
- HTTP仅接受opaque ID；location/path/凭据仅在服务端。认证、同源、会话及安全响应头保持。
- Range必须流式、有界并发/缓存、背压、200/206/416及断开取消；封面独立预算不占播放槽位。
- 读媒体接口不做远端写；既有显式WebDAV操作保留确认、权限与审计合同。
- 收藏、播放进度与recovery用自己的ports/repository；不可变migration/checksum。
- HTTP/存储测试用fake或loopback fixture，不读生产Cookie/秘密/Archive。
- 根scripts/check.sh负责交付验证；发布/回滚仅操作 ppvio 容器，并核实同机其他容器（如 tgvio）未变。
- 前端在本仓库web/；联动改动先落后端合同，再由web/src/api.ts消费。运维交接放docs/handoffs，不追加到本规范。
- 可选 renditions.json 必须绑定 package_id 与原清单摘要；验证父视频、相对路径、实际尺寸、时长和码率后才投影。副本不进入独立 Feed；永久删除须涵盖已登记副本并保留 tombstone，失败不得宣称完全删除。
- 可选 covers.json v2 绑定 package_id、原清单 SHA-256 和主视频 SHA-256；JPEG 为有界内容寻址对象，错误索引不隐藏原视频。临时读取失败保留已验证封面，正常移除索引才撤销投影。永久删除先删除已登记封面，封面失败保留原视频并反馈部分失败。

# PPVIO

一个只给自己用的视频播放器：从网盘（OpenList / WebDAV）读取短视频和长视频，手机上随时刷、随时看，不受 Telegram 限速。

```text
网盘（OpenList 挂载的 115 等） ──WebDAV / OpenList 直链──▶ PPVIO ──▶ 手机浏览器 / PWA
        ▲
        └── 可选：TGVIO 机器人把 Telegram 频道里的视频归档到这里
```

## 能做什么

- 短视频上下滑刷（没看过的优先），长视频独立播放器（续播、倍速、清晰度、手势）。
- 片库按日期 / 文件夹浏览、标签、筛选与排序；收藏、集合（自动在网盘建同名文件夹备份）。
- 封面与 480p 低清副本由播放器在空闲时自己生成（最低优先级，播放时让路）。
- 永久删除（可撤销，后台删净网盘文件）；疑似重复审核；同一视频多份时自动只留一份。
- 看过标记、隐私锁、闲置自动退出、可安装为手机应用（PWA）。
- 读取可走 WebDAV，或经 OpenList 直取 115 链接（更快）；本机磁盘缓存让起播与拖动更快。

视频目录可以是任意文件夹（递归找视频），也可以是 [TGVIO](https://github.com/Xioaruan912/TGVIO) 写出的归档包（`YYYY-MM-DD/<包>/manifest.json + _COMPLETE.json`）。

## 目录

| 路径 | 内容 |
|---|---|
| `src/ppvio/` | Python 服务（aiohttp + SQLite），入口 `python -m ppvio.main` |
| `web/` | 前端（React 19 + Vite + Tailwind v4），由服务在 `/` 提供 |
| `tests/` | 离线测试（fake / loopback / 临时库） |
| `scripts/` | 检查、构建、发布、回滚 |
| `deploy/ppvio.env.example` | 运行配置模板（复制到服务器 `/root/ppvio/ppvio.env`，权限 0600） |

## 开发与检查

```sh
python3 -m venv .venv && .venv/bin/pip install --require-hashes --no-deps -r requirements.lock
bash scripts/check.sh        # 源码与架构守卫、Python 测试、前端类型检查 / 测试 / 构建
```

## 部署

```sh
python3 scripts/release.py   # 只从已推送的 main 发布
```

本机构建镜像（前端来自同一提交，镜像标签 `io.ppvio.web.revision` 即该提交），镜像和源码带 SHA-256 传到服务器；
`scripts/remote_release.sh` 先留回滚点（旧镜像、env、SQLite 备份）再切换，新容器不健康会自动回滚。
服务只监听 `127.0.0.1:8790`，由宿主机 nginx 反代。网盘地址、账号与视频目录在网页 **设置 → 网盘存储** 里填写，不放在 env 里。

从 TGVIO 时代的 `tgvio-player` 迁移：第一次发布时 `scripts/adopt_tgvio_player.sh` 自动接管（数据目录原地移动、配置改名，失败自动还原旧容器）。

## 数据格式

网盘上的副本目录 `.tgvio/`、媒体 ID 的哈希域（`tgvio-file-v1` 等）和加密备份格式串（`tgvio-player-*`）沿用 TGVIO 时代的名字。
它们是已经写进网盘和数据库的数据格式，改名会让已有的封面、副本和备份失效，所以保持不变。

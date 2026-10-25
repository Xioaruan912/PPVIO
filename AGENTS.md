# PPVIO：开发约定

用户当前指令优先；历史材料不能授权新任务。开始工作先读本文件，再读 `src/ppvio/AGENTS.md`。

## 边界

- 独立项目。不 import、不读写 TGVIO 的代码、数据库、session 或 Telegram 凭据；与 TGVIO 只通过网盘目录（归档包合同 `manifest.json + _COMPLETE.json`）交接。
- 持久化格式标识（`.tgvio/`、`tgvio-file-v1`、`tgvio-rendition-v1`、`tgvio-folder-v1`、`tgvio-library-folder-v1:`、`tgvio-player-*` 加密/备份格式串、`tgvio.archive*` schema）不得改名。
- 不为整理项目替换框架、数据库、传输协议或依赖版本；依赖变更同步 lock。

## 代码地图

| 关注点 | 位置 |
|---|---|
| 装配与配置 | `src/ppvio/main.py`（`PPVIO_*` 环境变量）↔ `deploy/ppvio.env.example` ↔ `docker-compose.yml` |
| HTTP | `adapters/http/server.py` 总表；功能 mixin：streaming、media、library、storage_settings、status、read_mode、watched、duplicates、tags |
| 目录同步 | `application/catalog.py`；`infrastructure/folder_catalog.py`（普通文件夹与归档包）、`webdav_catalog.py` |
| 播放读取 | `application/archive_read.py`、`range_cache.py`、`infrastructure/range_store.py`、`faststart.py` |
| 封面与副本 | `infrastructure/rendition_maker.py`（ffmpeg，低优先级，播放时暂停） |
| 用户状态 | 收藏、集合、恢复快照、看过、标签 |
| 存储 | `infrastructure/sqlite.py` 聚合 `sqlite_*.py`；迁移 `infrastructure/migrations/NNNN_*.sql`（只增不改） |
| 前端 | `web/src`：`api.ts`、`feed/`、`player/`、`pages/`、`Settings.tsx`、`ui/` |

## 规则

- domain 纯业务；application 经 ports 编排；infrastructure 实现存储/协议；adapter 只做输入、授权与输出。`scripts/guard.py` 检查分层与 1000 行上限。新增前端 TS 模块不超过 600 行。
- 缺陷先用可复现测试锁定；测试全部离线，不连接生产网盘、不用生产 Cookie。
- 新表只新增 migration，先用生产库副本（SQLite backup API）演练。
- 一个提交一个目的：`feat/fix/refactor/test/docs(scope): ...`；不 force push。

## 交付

- `bash scripts/check.sh` 全绿后提交；发布只用 `python3 scripts/release.py`（clean、已推送的 main）。
- 发布只动 `ppvio` 容器；核对同机其他容器（如 `tgvio`）ID 与重启计数不变。
- 交付说明分清：Git 提交、镜像、实际运行容器；未验证的部分要写明。
- `.env`、密钥、session、用户媒体与数据库不得进入 Git、日志或截图。

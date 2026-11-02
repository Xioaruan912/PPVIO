# 91 的其他功能：待用户选择

用户要求先完成播放/缓存优化，再整理其他功能供选择。以下仅研究，未实现。91 是整个产品的参考，不限于缓冲。

已核对 91 的 main：`8ae80e1b031e6ea0e934ede57985bf888286952f`。源码是 MIT；如移植实质代码须保留版权和许可。91 使用 Go、ArtPlayer，PPVIO 是 Python/aiohttp、原生 video，适合迁移状态规则和独立模块，不宜整套替换。

## 建议选择

1. **播放失败自救（优先，中等改动）**：网络错误可有限重试并保留位置，认证/限流说明原因并停止自动重试；必要时使用兼容副本。PPVIO 已有直链刷新、直连到 WebDAV 的自动回退、HEVC 到兼容副本的选择，缺的是浏览器错误分类和恢复入口。
   - [错误诊断](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/src/lib/playbackError.ts#L19)
   - [刷新与候选切换](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/src/lib/videoSource.ts#L445)

2. **片库搜索与排序（先排序较小，再搜索中等）**：先把后端已有的时长、大小、随机、续播排序开放到前端，再增加标题/文件名搜索。现有标签、日期、文件夹、继续观看保留，不重复造。公开 API 仍只使用 opaque ID，不返回远端完整路径。
   - [搜索面板](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/src/components/SearchPanel.tsx#L17)
   - [筛选状态](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/src/lib/listingSearchParams.ts#L81)

3. **长视频滑动手势（中等）**：横滑显示目标位置，松手才 seek；竖滑按左右分区调整画面亮度/音量，保留现有双击跳转、长按倍速。浏览器不支持程序音量时需降级；画面亮度不冒充系统亮度。短视频的上下翻页不变。
   - [手势及松手提交](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/src/components/VideoPlayer.tsx#L2202)
   - [坐标和能力判定](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/src/lib/playerGestures.ts#L16)

4. **字幕选择（中等到较大）**：先找 WebDAV 同目录字幕、按需加载，字幕失败不影响视频播放。91 的字幕后端实际会查询光鸭匿名服务，不是通用本地旁挂字幕；可借鉴选择器和容错，不能直接照搬后端后宣称元数据完全本地。
   - [格式和选择器](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/src/components/VideoPlayer.tsx#L1105)
   - [实际字幕来源](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/backend/internal/subtitles/guangyapan.go#L26)

5. **卡片短预览（后做，中等到较大）**：悬停或明确操作才播放无声短片，离开视口释放；需要专用预览生成与存储预算，现有完整 480p 副本不等同于低成本预览。
   - [预览生命周期](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/src/lib/useCardPreview.ts#L15)

6. **一次性分享（后做，较大）**：独立凭证、仅授权指定视频、支持撤销/失效。91 实际是链接领取一次后创建六小时播放会话，未领取链接仍有效，不是看完即销毁。
   - [分享会话](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/backend/internal/api/video_shares.go#L25)
   - [原子领取](https://github.com/nianzhibai/91/blob/8ae80e1b031e6ea0e934ede57985bf888286952f/backend/internal/catalog/video_shares.go#L66)

## 无需再列为新功能

PPVIO 已有续播、继续观看、倍速、画中画、全屏、下一集倒计时、收藏、标签、合集、疑似重复、隐私锁与部分长按/双击手势。多网盘协议目前由 OpenList 承担，直接搬 91 驱动会重复引入账号刷新、风控和维护责任。

以上为源码核对与适配判断，没有运行 91，也没有对这些候选功能做性能或手机兼容实测。

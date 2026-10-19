# LingoCast Studio — 交接上下文

最后整理：2026-10-19
仓库：`D:\Codex\video-podcast`
远程：`https://github.com/Levine-Lai/lingocast-studio.git`（`main`）

## 产品目标

这是给个人使用的 Windows 本地优先双语视频字幕工作台，而不是纯 SRT 工具。

用户希望的完整流程：粘贴一个 YouTube 单视频链接或导入本地视频 → 下载 1080p 视频、英文字幕与封面 → 结合视频元数据及网络检索校正专名 → 语义重组英文字幕 → 用内置 MyMemory 接口生成中文 → 在类似剪映/PR 的时间轴中审核、编辑、对齐和设定样式 → 以**编辑预览完全一致**的样式烧录 MP4，同时把视频和 YouTube 封面放进同名导出文件夹。

默认导出根目录：`D:\Videos`。每个项目导出到 `D:\Videos\<安全项目名>\`，含烧录视频与 JPG 封面。

## 已确认的产品规范

- 本地桌面软件：Tauri 2 + React + TypeScript；项目数据在本地 SQLite，绝不上传视频、Cookie、数据库或 API Key。
- 编辑预览与烧录必须所见即所得。现在两者共用 `subtitleRaster.ts` 的 Canvas 栅格绘制；不要把烧录逻辑改回单独 ASS 样式而造成差异。
- 默认字幕为紧凑的双层样式：英文白色、中文黄色、圆角半透明灰背景、适度阴影。若某语言文本为空，不能显示该语言的空背景框。
- 画面上的字幕：单击选中整个字幕框并显示右侧样式面板；双击进入文字编辑。支持拖动位置；支持字体、字号、颜色、描边、粗体、阴影、透明度、背景色/透明度、背景开关和“全部修改”。
- 中文与英文可手动换行，预览与烧录都必须保留换行；双语多行不能重叠。
- 时间轴须支持滚轮/触摸板/触摸屏双指缩放、平滑横向移动、长按拖动播放头、片段拖动和左右边缘缩放、播放头及相邻边界磁吸、拆分/合并/新增/删除。播放时选中当前 cue 并定位对应编辑行。
- 常用快捷键：Space 播放暂停；Ctrl+C/V/X/A/Z/Y、Ctrl+Shift+Z、Ctrl+S；Delete 删除字幕。不要劫持普通的 `.`/`。` 输入作为保存快捷键。
- 左侧项目栏可收起；项目可删除；切换项目保持原位置，不应把最近打开项目移到顶部；烧录完成后项目项显示 `✓`。
- 通知默认约 5 秒自动消失。

## 字幕内容与时序标准

- 去掉 `>>`、`[music]`、掌声/笑声标记、音乐符号、HTML 等非口语内容。
- 每段英文与中文末尾均不要 `.` 或 `。`；保留手动换行。
- 中文字幕是简体、简洁、自然的口语表达：可省略无意义填充和重复（例如连续 Thank you），但不得丢失事实、数字、否定或态度。
- 已核实的英文人名/队名/品牌等，在中文行中保留完整拉丁拼写，**不要音译**（例如 `Dylan Cease`）。
- 不同说话人绝不合并。来源字幕块只是时间提示，必须按完整语义/语法重组；不拆开主谓宾、专名、介词结构、否定、条件/因果、引语等。
- 连续讲话过长时，应在真实从句边界或最强节奏点切分；长停顿、换人或换话题则必须断开。不要人为加明显空隙，也不要造成零间隔闪烁。
- timing 以真实说话为准。需要 word-level 对齐时，覆盖率低的 cue 不能静默移动。普通连续讲话的相邻 cue 维持约 80–240 ms 的自然呼吸间隔；不要延迟下一句的真实开口。
- 英文两行换行要平衡，避免第一行满、第二行仅两三个词。

## 关键目录与职责

```text
desktop/src/                 React 界面与前端逻辑
desktop/src/lib/platform.ts  Tauri 调用、文件授权、下载/烧录入口
desktop/src/lib/subtitleRaster.ts
                             预览/烧录共用 Canvas 字幕栅格绘制与压缩包生成
desktop/src/lib/repository.ts
                             SQLite 项目读写、迁移相关前端逻辑
desktop/src/hooks/useStudio.ts
                             项目状态、自动保存、选择与撤销重做
desktop/src-tauri/src/lib.rs Rust 命令、yt-dlp、DeepSeek、FFmpeg、SQLite 迁移
desktop/scripts/import-reviewed-project.mjs
                             video-subs 导入后的语义重组、翻译与写入项目
desktop/scripts/publish-portable.ps1
                             本地便携 EXE + 固定桌面快捷方式
desktop/worker/              Python 媒体能力与说明（非首选主路径）
.github/workflows/release-portable.yml
                             push main 后测试、构建、上传便携 EXE Artifact
C:\Users\24979\.codex\skills\video-subs\
                             将 YouTube URL 做成待审核项目的个人 Skill
```

## YouTube / `video-subs` 工作流

触发：用户直接调用 `$video-subs`，或给 YouTube 链接并要求按既定字幕规范导入。

1. 只处理 URL 中的视频 ID，忽略 playlist/index/timestamp，不能下载整个播放列表。
2. 在 Skill 目录执行：

   ```powershell
   node scripts/import_to_lingocast.mjs --url "YOUTUBE_URL" --prepare-only
   ```

   读取 manifest 和选定英文 SRT，先复用已下载素材。
3. 根据标题、频道、简介和可信网页检索，核实罕见人名、球队、品牌、地点与术语。只提供高置信度 `verifiedTerms` 和 `wrong => correct`，不猜测。
4. 导入：

   ```powershell
   node scripts/import_to_lingocast.mjs --manifest "MANIFEST_PATH" --verified-json '[...]' --corrections-json '{...}'
   ```

   然后验证项目存在、视频/JPG 存在、cue 数大于 0 且所有 cue 已翻译。
5. 超长原始字幕块要用 Skill 中的本地 word-level 转录/对齐脚本，不能靠词数线性分摊最终时间。

下载可靠性：脚本优先缓存；依次使用持久 Cookie、浏览器配置、代理直连、已有本地文件、YouTube 字幕、Whisper 转录。不要用临时 ad-hoc `yt-dlp` 绕过 Skill。若所有路径均被 YouTube 登录拦截，唯一需要用户做的一次修复是：安装/打开 Firefox、登录 YouTube、关闭 Firefox 后重跑；后续链接会自动复用其 profile。Cookie 会被 YouTube 或 IP 风控撤销，不能承诺永久绕过。

## 当前版本与已完成进度

0.9.2 新增通用本地 JSON 自动化入口，见 `desktop/AUTOMATION.md` 与根目录 `AGENTS.md`。包含独立注释轨、重叠字幕、视频片段剪辑与拼接，发布脚本写入带 SHA-256 的 latest.json 供 agent 启动最新版。翻译当前使用 MyMemory；本地分句不会请求 DeepSeek。

以下提交/Actions 信息为 0.8.8 历史记录：

- 当前版本：`0.9.2`（`desktop/package.json`、`tauri.conf.json` 与 `Cargo.toml` 必须一致）。
- 最新已推送提交：`c4baaf5 Harden subtitle burning pipeline`。
- GitHub Action `31800162187` 已成功：前端/Rust 测试、Windows 便携构建与 90 天 Artifact 留档均通过。
- 对应 GitHub Issue #1 已有修复说明：<https://github.com/Levine-Lai/lingocast-studio/issues/1>。

### 最近修复（`c4baaf5`）

- 烧录前端使用 cue 最大结束时间作为后备；Rust 后端用 `ffprobe` 获取真实媒体时长，防止时长为 0 时静默生成无字幕视频。
- FFmpeg 的旧字段 `out_time_ms` 实际是微秒，已在代码和回归测试中明确处理。
- 超长视频烧录不再把每张 PNG 都单独 Base64 过 IPC：`subtitleRaster.ts` 复用一个 1920×1080 Canvas、缓存字体，并将图层压成单个 gzip `LCOV1` 二进制包；Rust 解压后写入时间线。视觉渲染未改变。
- Tauri 从 `csp: null` 和全局资产访问 `scope: ["**"]` 改为严格 CSP；前端在每次本地视频使用前调用 `authorize_video_asset`，后端只允许经过 canonicalize 且扩展名受限的视频文件。
- 视频已被移动/删除时，旧项目仍可打开和编辑；预览缺失但不会阻塞整个工作区，导出会给出精确错误。
- 删除无实际功能的质量审核代码与 `jobs` 表迁移；保留真正使用的 worker/status 兼容逻辑。
- 本地发布脚本若旧便携 EXE 被 Explorer/杀毒短暂锁定，会自动以内容 hash 创建备用 EXE，并将固定桌面快捷方式 `LingoCast Studio.lnk` 指向新构建。

## 构建、验证与发布

前置：Windows 10/11、Node 22+、Rust stable、FFmpeg、yt-dlp、WebView2。翻译使用免 Key 的 MyMemory 接口；网络与额度限制仍可能影响翻译。

```powershell
cd D:\Codex\video-podcast\desktop
npm ci
npm test
npm run build
cd src-tauri
cargo test

# 回到 desktop 后生成便携版并刷新桌面快捷方式
cd ..
npm run release:portable
```

真实烧录回归测试（需要 FFmpeg）：

```powershell
cd D:\Codex\video-podcast\desktop\src-tauri
cargo test burns_ass_subtitles_into_a_real_mp4 -- --ignored
```

每次推送 `main` 会触发 `.github/workflows/release-portable.yml`：测试 + `--no-bundle` 构建 + Artifact。普通改动无需 GitHub Release 或版本号递增；另一台电脑可下载最近成功 Action 的 Artifact 或从源码构建。

## 本地文件、隐私与安全

- 视频、下载缓存、缩略图、SQLite、Cookie 和 API Key 不能进 Git。
- 默认导出 `D:\Videos`；项目本地数据通常位于应用数据目录，不在仓库。
- 不要在终端、Issue、commit 或日志中输出 Cookie、浏览器数据、代理凭据、API Key。
- 视觉识别配置仅为可选项；不得用于人脸识别，只能读取公开缩略图中可见的文字。

## 本次提交范围

用户于 2026-10-19 明确要求提交所有现有改动，包括此前尚未提交的字幕导入增强、注释轨、视频剪辑、审校脚本及 context.md。后续请以 `git status -sb` 和当前提交历史为准，不再把 2026-08-23 的未提交清单当作现状。

## 后续 agent 的操作准则

1. 先运行 `git status -sb`，尊重上述未提交文件；不要用 `git reset --hard`、`git checkout --` 或清理缓存/下载目录。
2. 修改字幕样式或烧录时，至少验证预览和真实 MP4 的同一帧；WYSIWYG 是核心验收标准。
3. 修改自动导入/翻译时，优先通过 `$video-subs` 的规定流程；对专名必须先做可信检索再修正。
4. 每次功能改动至少运行 `npm test`、`npm run build`、`cargo test`；涉及烧录再跑 ignored 的真实 FFmpeg 测试。
5. 发布便携版后核对桌面快捷方式 TargetPath 与 EXE SHA-256；旧 EXE 被锁时接受 hash 后缀备用文件，不要强杀用户的应用。
6. 用户已要求每个有效更新同步 GitHub 留档。工作树混杂时，只显式 `git add` 本次文件；推送 `main` 后检查 Action，不必创建 GitHub Release。

## 已知边界 / 候选下一步

- 无英文字幕的视频目前依赖本地 Whisper 回退；真实语音识别质量、耗时和模型部署仍是重点验证项。
- YouTube 的反机器人/登录限制由外部平台控制。缓存与 Firefox profile 自动复用已尽量降低重复 Cookie 操作，但无法承诺每个链接都无需重新验证。
- 长播客的分句可读性、专名与翻译仍需人工审核；本地脚本验证覆盖和长度，不承诺自动达到人工审校质量。
- 便携版本地文件被系统占用时会产生同版本 hash 后缀 EXE；快捷方式保持唯一且正确。日后可在确认未运行后做安全的旧构建清理，但不要自动递归删除。

## 0.9.2 验证记录（2026-10-19）

- 前端 44 项测试通过；TypeScript + Vite 生产构建通过。
- Rust 18 项测试全部通过，包含真实 FFmpeg 字幕烧录、视频与音频剪辑拼接。
- 实际导入脚本：临时 SQLite、真实 FFmpeg 素材、在线 MyMemory 翻译写入成功，英文 token 完整覆盖。
- 审校对齐脚本：dry-run、100% 覆盖写入、低覆盖拒绝且原数据保持通过。
- 发布版 0.9.2 的 CLI 端到端检查通过：status/list/import/get/replace-cues/style/segments/srt/burn/delete。3 秒源视频移除中间 1 秒后输出 2 秒 MP4，画面包含中英字幕和独立注释轨，已人工查看导出帧。
- 本地便携发布、桌面快捷方式目标和 SHA-256 校验通过。运行实例为 bundle 内的 0.9.2 EXE，启用了本地自动化。
- 本次没有通过新 YouTube 链接测试外部下载/登录链路；该链路仍受网络和平台登录限制。

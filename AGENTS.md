# LingoCast Studio

制作或修改网页时，文案简洁实用，沿用已有风格，不添加宣传口号、重复标题或开发实现说明。

## 操作软件

先读 `desktop/AUTOMATION.md`。所有本地 agent 均可用 Node CLI 操作发布版，不需要 Codex 专属工具。

在 `desktop` 目录运行 `node scripts/agent.mjs --launch`，再用 `status` 检查实际版本和可用操作。已有自动化实例时复用，勿重复启动。普通桌面启动默认不启用自动化。

支持项目查询、导入、字幕与样式编辑、剪辑、翻译、SRT、所见即所得 MP4 烧录。先读取项目再修改，优先使用 `--request` JSON 文件。命令失败退出码为 1。超时且已开始的任务不得直接重发，以免重复导入或导出。人工编辑与自动化不要同时进行。

## 开发与发布

- 保留用户已有改动，不执行破坏性清理。
- 修改后在 `desktop` 运行 `npm test`、`npm run build`，在 `desktop/src-tauri` 运行 `cargo test`；涉及烧录或剪辑还要运行 `cargo test -- --include-ignored`（需要 FFmpeg）。
- 预览和烧录共用 `subtitleRaster.ts`；不得替换成不同的字幕样式实现。
- `desktop/package.json`、npm lock、Cargo manifest/lock、Tauri 配置版本须一致。
- `npm run release:portable` 构建、刷新唯一桌面快捷方式，并生成带 SHA-256 的 `bundle/latest.json`；CLI 启动前校验哈希。
- 用户配置、Key、Cookie、媒体、数据库、构建产物不进 Git。

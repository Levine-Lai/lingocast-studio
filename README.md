# LingoCast Studio

LingoCast Studio 是一款本地优先的 Windows 双语视频字幕编辑器。它可以从本地视频或 YouTube 导入素材，整理英文字幕、通过 DeepSeek 生成口语化中文字幕，在时间轴中编辑和对齐字幕，并把预览样式真正烧录进 MP4。

项目采用 [Tauri 2](https://tauri.app/) + React + TypeScript，字幕项目保存在本机 SQLite 数据库中。视频、字幕数据库、Cookie 和 API Key 不会包含在本仓库中。

## 主要功能

- YouTube 单视频下载、字幕获取、封面保存和下载恢复
- 英文字幕去噪、自然断句、专名审查与中英双语翻译
- 可缩放时间轴、字幕块拖动、磁吸、拆分、合并及撤销/重做
- 中英字幕内容、时间、位置、字体、颜色、描边、阴影和背景编辑
- 预览与烧录共用同一套栅格渲染，实现所见即所得
- FFmpeg 烧录进度、视频与 YouTube 封面同目录导出
- 本地项目持久化及已烧录状态标记

## 运行要求

- Windows 10/11
- Node.js 22+
- Rust stable 工具链
- [FFmpeg](https://ffmpeg.org/) 和 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 可从 `PATH` 找到
- Microsoft Edge WebView2 Runtime（Windows 11 通常已自带）
- DeepSeek API Key（仅翻译功能需要）

把 `.env.example` 复制到以下任一位置并填写 Key：

```text
%APPDATA%\com.lingocast.studio\.env.local
```

也可以在开发时放置于仓库根目录的 `.env.local`。这些文件已被 Git 忽略。

## 本地开发

```powershell
cd desktop
npm ci
npm run tauri -- dev
```

验证代码：

```powershell
npm test
npm run build
cd src-tauri
cargo test
```

## 发布便携版

```powershell
cd desktop
npm run release:portable
```

该命令会构建当前版本的便携 EXE，并把桌面上的 `LingoCast Studio.lnk` 更新为指向最新版。便携 EXE 属于构建产物，不进入 Git 历史。

## GitHub 自动留档

每次将新版本推送到 `main` 后，GitHub Actions 会：

1. 运行前端与 Rust 测试
2. 构建 Windows 便携版
3. 把便携 EXE 上传到该次 Actions 运行的 Artifacts，保留 90 天

普通更新不要求修改版本号，也不会自动创建 GitHub Release。源码提交会永久保存在 GitHub；另一台 Windows 电脑可以从最新一次成功的 Actions 运行中下载便携 EXE，或者克隆源码自行构建。正式对外发布版本时，再手动创建 Release 即可。

## 隐私与安全

- 不要提交 `.env.local`、Cookie、SQLite 数据库或用户视频
- YouTube 登录凭证仅保存在本机应用数据目录
- DeepSeek API Key 只由本地后端读取，不应写入前端源码
- GitHub Actions 构建产物只包含编译后的应用，不包含个人素材

## License

[MIT](LICENSE)

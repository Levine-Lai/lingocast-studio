# LingoCast Studio Desktop

## 发布便携版

在 `desktop` 目录运行：

```powershell
npm run release:portable
```

命令会构建不依赖 NSIS 安装器的便携版，并覆盖桌面上固定名称的
`LingoCast Studio.lnk`。快捷方式始终指向刚发布的版本，因此桌面不会累积多个版本入口。

如已完成构建、只需重新生成当前版本的便携文件和桌面快捷方式，可运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-portable.ps1 -SkipBuild
```

面向个人使用的本地视频字幕工作台。桌面壳使用 Tauri 2，界面使用 React + TypeScript，项目和字幕数据保存在本机 SQLite 中。

## 当前版本（0.8.8）

- 导入本地视频和 SRT 字幕
- 粘贴单个 YouTube 视频网址，自动获取英文字幕并通过 DeepSeek 生成中文字幕；缺失翻译会自动缩小范围重试并逐条补译
- 字幕编辑自动保存，切换项目不会丢失译文；旧的纯英文项目打开后会自动补齐并保存中文字幕
- 自动把 YouTube 滚动字幕重组为完整、连贯且不重叠的语句
- 视频预览、字幕叠加和时间轴定位
- 编辑原文、译文、说话人和时间码
- 新增、拆分、合并、删除字幕，以及前后微调 100ms
- 类剪映/PR 时间轴：鼠标滚轮和触摸屏双指缩放、横向滚动、片段拖动和左右手柄调整长度
- 一次字幕块拖动或边缘缩放只生成一条历史记录，按一次撤销即可回到本次拖动前的位置，并可正常重做
- 播放期间以逐帧时间更新驱动播放头，并自动定位当前字幕块和对应编辑行
- 视频预览、时间轴和字幕编辑区可拖动调整高度，字幕编辑行高也可单独调节
- 支持 Ctrl+C/V/X/A、Ctrl+Z/Y、Ctrl+Shift+Z、Ctrl+S 和空格键等常用快捷键
- 可收起项目侧栏，以及空格键播放/暂停
- 紧凑的白色英文、黄色中文双层烧录效果预览，采用低行距和半透明背景，减少画面遮挡
- 自动清除 `>>`、`[Music]`、音乐符号和中英文句号，并保留编辑器中的手动换行
- 字幕灰色背景可随时开关，预览和最终烧录视频使用同一选项
- 时间轴播放头支持长按拖动，字幕边缘调整时可磁吸播放头和相邻字幕边界
- 通过 FFmpeg 把中英双语字幕真正烧录进 MP4 视频，而不只是导出 SRT
- 多行中英文字幕采用独立行距，不再发生上下重叠；预览与烧录使用一致的淡灰色背景
- 时间轴工具栏可直接新增字幕块，Delete 键可删除当前字幕
- 烧录导出根据 FFmpeg 实际编码时间显示 0–100% 实时进度
- 兼容 YouTube 下载器输出中的特殊字符和非 UTF-8 文件路径
- 本地项目保存与双语 SRT 导出
- Python 媒体工作进程协议与 FFmpeg / yt-dlp 能力探测

YouTube 下载需要系统能够找到 `yt-dlp` 和 FFmpeg。DeepSeek 配置保存在 `%APPDATA%\com.lingocast.studio\.env.local`，需要 `DEEPSEEK_API_KEY`，可选 `DEEPSEEK_API_BASE` 和 `DEEPSEEK_MODEL`。没有英文字幕的视频仍需要下一阶段的语音识别能力。

## 开发

```powershell
npm install
npm run tauri -- dev
```

前端测试与构建：

```powershell
npm test
npm run build
```

生成 Windows 便携版：

```powershell
npm run release:portable
```

推送新版本到 GitHub 的 `main` 分支后，仓库级 GitHub Actions 会自动运行测试、构建便携 EXE，并创建对应版本的 GitHub Release。发布前必须提升并同步 `package.json`、`Cargo.toml` 与 `tauri.conf.json` 的版本号。

媒体工作进程说明见 [`worker/README.md`](worker/README.md)。

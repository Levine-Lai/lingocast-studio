# Agent / 自动化接口（0.9.3）

需要 Windows、Node.js 22+、FFmpeg / ffprobe；YouTube 下载另需 yt-dlp。任何能够执行命令的 agent 都可以调用，不依赖 Codex、浏览器调试端口或鼠标坐标。

## 启动和检查

在 `desktop` 目录运行：

```powershell
node scripts/agent.mjs --launch
node scripts/agent.mjs status
node scripts/agent.mjs list
```

`--launch` 读取本机发布时生成的 `src-tauri/target/release/bundle/latest.json`，校验 EXE 的 SHA-256 后启动。首次使用先执行 `npm run release:portable`。已有启用自动化的实例时直接复用，只运行一个实例。普通桌面快捷方式启动不启用接口。

GitHub Actions 便携包和本地 bundle 同时附带 `agent.mjs`、`latest.json` 和本说明。其他电脑解压后，在该目录运行 `node agent.mjs --launch`，再运行 `node agent.mjs status` 即可。也可手动启动：

```powershell
$env:LINGOCAST_AUTOMATION = '1'
Start-Process -FilePath 'C:\Apps\LingoCast Studio_0.9.2_portable.exe' -WindowStyle Hidden
```

## 请求与响应

把请求保存为 UTF-8 JSON 文件（Windows 路径用 `\\` 或 `/`）：

```json
{"action":"import","params":{"name":"Interview","videoPath":"D:/Videos/interview.mp4","cues":[{"startMs":0,"endMs":2000,"sourceText":"Hello","targetText":"你好"}]}}
```

```powershell
node scripts/agent.mjs --request request.json --timeout 3600
```

stdout 返回一行 `{"ok":true,"result":...}` 或 `{"ok":false,"error":"..."}`，失败退出码为 1。直接运行 `node` 可避免 npm 在 stdout 额外输出日志。默认超时 600 秒，长视频烧录可增大。

| action | params | result |
| --- | --- | --- |
| status | 无 | 运行版本、actions、busy、dirty、当前 projectId |
| list | 无 | 项目列表 |
| get | projectId | 完整项目、字幕、样式、剪辑片段 |
| open | projectId | 在编辑器打开项目 |
| delete | 必须显式指定 projectId | 删除项目及字幕，保留原媒体 |
| import | videoPath、name，可选 cues 或 srt（文本） | projectId、cueCount；时长由 ffprobe 读取 |
| youtube | url | 下载视频/封面/字幕并导入；需要网络及有效的本地登录状态 |
| replace-cues | projectId、cues | 整批替换字幕；可增加/删除/拆分/合并/修改文本、时间、kind、单条 subtitleStyle |
| style | projectId、style | 合并项目级字幕样式 |
| segments | projectId、segments | 数组元素为 startMs、endMs、removed；须从 0 连续覆盖完整原始时长且保留至少一段；空数组恢复全片 |
| translate | projectId | 调用软件当前翻译接口，保存译文 |
| srt | projectId | 双语 SRT 字符串，按剪辑后时间映射 |
| burn | projectId、outputPath | MP4 绝对路径；返回视频路径、封面路径、封面错误 |

除 import/youtube 外，projectId 可省略以使用当前项目。建议显式提供，避免操作错项目。字幕字段与样式定义见 `src/types.ts`。`replace-cues` 会生成新 ID；后续操作先重新 `get`。空 cues 数组表示清空字幕。重叠 cue 可以用于注释轨道。烧录复用界面 Canvas 栅格和剪辑逻辑，无保存对话框；输出文件会被覆盖，不能指定原视频路径。

人工编辑与自动化不要同时进行；有未保存内容或软件正在下载/翻译/烧录时请求会被拒绝。自动化任务串行执行；长任务期间后续请求也会等待。英文导入后可能触发软件自带的自动翻译，可用 status 检查 busy。翻译效果与外部服务可用性仍需审核。

## 一条命令生成字幕项目

`auto-subtitle.mjs` 复用 video-subs 的下载缓存和 DeepSeek 翻译，自动完成：素材准备 → 语义分句/翻译 → Whisper 词级时间戳 → 对齐与间隙校准 → 写入软件。首次运行会启动自动化实例。

```powershell
node scripts/auto-subtitle.mjs --url "https://www.youtube.com/watch?v=VIDEO_ID"
node scripts/auto-subtitle.mjs --url "https://www.youtube.com/watch?v=VIDEO_ID" `
  --verified-json "@verified.json" --corrections-json "@corrections.json"
```

可选参数：`--name` 项目名、`--model small.en` Whisper 模型、`--skip-align` 跳过词级对齐、`--keep-temp` 保留临时数据库。`--verified-json` 是确认过的专名数组，`--corrections-json` 是 `{"错误":"正确"}` 映射；省略时只做通用翻译和上下文校正。

依赖：`VIDEO_SUBS_SKILL`（默认 `%USERPROFILE%\.codex\skills\video-subs`）、`python` + `faster_whisper`、`yt-dlp`、FFmpeg，以及 `%APPDATA%\com.lingocast.studio\.env.local` 中的 DeepSeek Key。配置 Key 时默认使用 DeepSeek；没有 Key 时自动回退 MyMemory，也可用 `VIDEO_SUBS_TRANSLATOR=mymemory` 强制回退。命令成功时 stdout 输出项目 ID、字幕数、覆盖率相关统计和间隙分布。

## 本地协议与故障恢复

接口只读取当前用户 `%APPDATA%/com.lingocast.studio/automation`，不开网络端口。该目录与应用数据库一样只供可信本地进程访问。请求原子写入 UUID.request.json，软件领取为 UUID.running.json，结束原子写入 UUID.response.json；CLI 读取响应后删除。过期且尚未执行的请求不会修改项目。

超时后 CLI 会撤回尚未领取的请求。若已领取，任务可能仍在运行；错误消息包含 UUID。检查对应 response 文件或项目/导出状态后再决定下一步，不能盲目重发修改命令。软件中途退出留下的 running 文件不会自动重放；检查结果后可手动删除。本协议不提供事务回滚或任务取消。

## 验证

启动自动化实例后，在源码的 desktop 目录运行 `node scripts/smoke-agent.mjs`。它生成临时视频，验证导入、查询、字幕修改、样式、剪辑、SRT、真实 MP4 和字幕像素，成功后删除其自身测试项目；临时媒体留在系统 Temp 供检查。

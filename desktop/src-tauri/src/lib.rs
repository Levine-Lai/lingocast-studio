use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
};
use url::Url;

const PROGRESS_PREFIX: &str = "lingocast-progress:";
const FILE_PREFIX: &str = "lingocast-file:";
const TITLE_PREFIX: &str = "lingocast-title:";
const ID_PREFIX: &str = "lingocast-id:";
const DESCRIPTION_PREFIX: &str = "lingocast-description:";
const CHANNEL_PREFIX: &str = "lingocast-channel:";
const DEFAULT_EXPORT_DIRECTORY: &str = r"D:\Videos";
const TRANSLATION_SYSTEM_PROMPT: &str = r#"你是专业的中英双语口语视频字幕编辑。只返回 JSON。

任务：结合 videoContext、verifiedTerms 和 context 的前后语境，先审查英文自动字幕中的专有名词，再把 targetIndices 指定的 transcript 逐条翻译成自然、简洁、适合直接观看的简体中文口语字幕。每个目标 index 必须恰好返回一次，不得合并、拆分、错序或省略。

翻译原则：
1. 先理解说话者在当前语境中的真实意图、态度和语气，再用中国人日常说话的方式表达；不要机械逐词直译，也不要擅自补充原文没有的信息。
2. 根据语境处理口头填充词、话语标记、停顿词、自我修正、口吃和无意义重复。像 I mean、you know、well、like、um、uh 等不能固定套用一个译法：有实际语气或逻辑作用时译成“我认为”“其实”“就是说”“你也知道”等最合适的说法，没有信息作用时可自然省略。
3. 同一说话者在同一条字幕中连续重复的致谢、问候、肯定、称呼或短语，如果只是口头重复而非强调，只保留一次自然表达，例如连续两个 Thank you 可译为一个“谢谢”；如果重复承担强调、节奏、情绪或不同说话者回应的作用，则必须保留其含义。
4. 允许压缩不影响信息的赘词和重复，但姓名、数字、事实、观点、因果、否定、程度和关键信息必须准确保留。
5. 中文字幕应短、顺、口语化，与英文时长匹配；避免书面腔、翻译腔和不自然的代词堆叠。
6. zh 结尾禁止使用英文句点 .、中文句号 。或全角句点 ．；问号、感叹号等确有语气时可以保留。
7. 仅在上下文能明确判断说话人时填写 speaker，否则返回空字符串。
8. 对人名、队名、地名、品牌、节目名和专业术语进行高置信度校正。优先采用 videoContext 标题、频道、简介以及 verifiedTerms 中出现的完整拼写。例如上下文明示 Dylan Cease 时，可把误识别的 Dylan C 校正为 Dylan Cease。不要仅凭读音臆造姓名；证据不足时必须保留原英文。
9. en 只能修正明确的转录错误、大小写和专有名词拼写，禁止改写普通口语、增删事实或改变原意；en 和 zh 结尾均禁止使用英文句点 .、中文句号 。或全角句点 ．。
10. 经过 videoContext、verifiedTerms 或上下文确认的英文人名，在 zh 中必须直接保留校正后的拉丁字母完整拼写，禁止音译、意译或替换成中文姓名。例如 Dylan Cease 在中文字幕中仍写作 Dylan Cease。

返回结构：{"items":[{"index":0,"en":"校正后的英文字幕","zh":"自然的中文字幕","speaker":""}]}"#;
const TERM_REVIEW_SYSTEM_PROMPT: &str = r#"你是专业的视频字幕专名审校员。只返回 JSON。

结合视频标题、频道、简介、已有 verifiedTerms 和完整英文转录，识别所有可能被自动字幕写错的人名、队名、地名、品牌、节目名及专业术语。必须先理解视频主题和上下文；不要只检查人名，也不要局限于某个示例。

规则：
1. 只有拼写能被标题、简介、频道、已有 verifiedTerms、转录中的明确上下文或你有把握的常识交叉确认时才校正；证据不足时不要猜。
2. corrections 的 wrong 必须是转录里实际出现的连续原文，correct 是确认后的完整拼写；不要改写普通口语。
3. verifiedTerms 只返回值得在后续所有字幕中保持一致的规范拼写。
4. 英文人名保持拉丁字母，不要音译。

返回结构：{"verifiedTerms":["Dylan Cease"],"corrections":[{"wrong":"Dylan C","correct":"Dylan Cease"}]}"#;

fn safe_file_name(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            value if value.is_control() => '_',
            value => value,
        })
        .collect::<String>();
    let cleaned = cleaned
        .trim()
        .trim_matches('.')
        .chars()
        .take(96)
        .collect::<String>();
    if cleaned.is_empty() {
        "LingoCast".to_string()
    } else {
        cleaned
    }
}

#[tauri::command]
fn ensure_export_directory(project_name: String) -> Result<String, String> {
    let directory = Path::new(DEFAULT_EXPORT_DIRECTORY).join(safe_file_name(&project_name));
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建默认导出目录 {DEFAULT_EXPORT_DIRECTORY}：{error}"))?;
    Ok(directory.to_string_lossy().into_owned())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeDownloadProgress {
    job_id: String,
    percent: f64,
    status: String,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadedVideo {
    path: String,
    name: String,
    subtitles: Vec<DownloadedSubtitle>,
    source_context: VideoSourceContext,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoSourceContext {
    title: String,
    description: String,
    channel: String,
    #[serde(default)]
    verified_terms: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadedSubtitle {
    language: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationCueInput {
    id: String,
    source_text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslatedSubtitleCue {
    id: String,
    source_text: String,
    target_text: String,
    speaker: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BurnCueInput {
    start_ms: f64,
    end_ms: f64,
    source_text: String,
    target_text: String,
    #[serde(default)]
    style: Option<BurnStyleInput>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BurnOverlayInput {
    start_ms: f64,
    end_ms: f64,
    png_base64: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BurnStyleInput {
    position_x: f64,
    position_y: f64,
    source_color: String,
    target_color: String,
    source_font_size: f64,
    target_font_size: f64,
    source_font_family: String,
    target_font_family: String,
    bold: bool,
    shadow: bool,
    outline_color: String,
    outline_width: f64,
    text_opacity: f64,
    background_enabled: bool,
    background_color: String,
    background_opacity: f64,
    line_height: f64,
    line_gap: f64,
}

impl Default for BurnStyleInput {
    fn default() -> Self {
        Self {
            position_x: 50.0,
            position_y: 5.0,
            source_color: "#f7f8f4".into(),
            target_color: "#ffe37b".into(),
            source_font_size: 48.0,
            target_font_size: 52.0,
            source_font_family: "Arial".into(),
            target_font_family: "Microsoft YaHei".into(),
            bold: true,
            shadow: true,
            outline_color: "#000000".into(),
            outline_width: 0.0,
            text_opacity: 1.0,
            background_enabled: true,
            background_color: "#666666".into(),
            background_opacity: 0.62,
            line_height: 1.18,
            line_gap: 6.0,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoBurnProgress {
    job_id: String,
    percent: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BurnedVideoOutput {
    video_path: String,
    cover_path: Option<String>,
    cover_error: Option<String>,
}

fn ass_timestamp(milliseconds: f64) -> String {
    let centiseconds = (milliseconds.max(0.0) / 10.0).round() as u64;
    let hours = centiseconds / 360_000;
    let minutes = (centiseconds % 360_000) / 6_000;
    let seconds = (centiseconds % 6_000) / 100;
    let fraction = centiseconds % 100;
    format!("{hours}:{minutes:02}:{seconds:02}.{fraction:02}")
}

fn ass_escape(value: &str) -> String {
    value
        .replace('\r', "")
        .replace('\\', r"\\")
        .replace('{', r"\{")
        .replace('}', r"\}")
        .replace('\n', r"\N")
        .trim()
        .to_string()
}

fn ass_color(hex: &str, opacity: f64) -> String {
    let value = hex.trim().trim_start_matches('#');
    let rgb = u32::from_str_radix(value, 16).unwrap_or(0);
    let red = (rgb >> 16) & 0xff;
    let green = (rgb >> 8) & 0xff;
    let blue = rgb & 0xff;
    let alpha = ((1.0 - opacity.clamp(0.0, 1.0)) * 255.0).round() as u32;
    format!("&H{alpha:02X}{blue:02X}{green:02X}{red:02X}")
}

fn ass_font(value: &str, fallback: &str) -> String {
    let sanitized = value.replace([',', '\n', '\r'], " ").trim().to_string();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn ass_style_line(name: &str, style: &BurnStyleInput) -> String {
    let border_style = if style.background_enabled { 3 } else { 1 };
    let outline = style.outline_width.clamp(0.0, 8.0);
    let shadow = if style.shadow { 2 } else { 0 };
    let back_colour = if style.background_enabled {
        ass_color(&style.background_color, style.background_opacity)
    } else {
        "&HFF000000".to_string()
    };
    let outline_colour = ass_color(&style.outline_color, style.text_opacity);
    let source_colour = ass_color(&style.source_color, style.text_opacity);
    let bold = if style.bold { -1 } else { 0 };
    let source_font = ass_font(&style.source_font_family, "Arial");
    let source_size = style.source_font_size.clamp(18.0, 96.0);
    format!(
        "Style: {name},{source_font},{source_size},{source_colour},{source_colour},{outline_colour},{back_colour},{bold},0,0,0,100,100,0,0,{border_style},{outline},{shadow},2,112,112,46,1\n"
    )
}

fn ass_dialogue_text(
    cue: &BurnCueInput,
    style: &BurnStyleInput,
    style_name: &str,
) -> Option<String> {
    let source = ass_escape(&cue.source_text);
    let target = ass_escape(&cue.target_text);
    if source.is_empty() && target.is_empty() {
        return None;
    }
    let x = (1920.0 * style.position_x.clamp(3.0, 97.0) / 100.0).round() as i64;
    let y = (1080.0 * (1.0 - style.position_y.clamp(1.0, 80.0) / 100.0)).round() as i64;
    let source_font = ass_font(&style.source_font_family, "Arial");
    let target_font = ass_font(&style.target_font_family, "Microsoft YaHei");
    let source_size = style.source_font_size.clamp(18.0, 96.0);
    let target_size = style.target_font_size.clamp(18.0, 96.0);
    let source_colour = ass_color(&style.source_color, style.text_opacity);
    let target_colour = ass_color(&style.target_color, style.text_opacity);
    let bold = if style.bold { -1 } else { 0 };
    let effective_gap = style.line_gap.clamp(0.0, 36.0)
        + (style.line_height.clamp(0.9, 1.8) - 1.0).max(0.0) * (source_size + target_size) / 2.0;
    let bilingual_separator = if effective_gap >= 1.0 {
        let gap_size = effective_gap.round() as i64;
        format!(
            r"\N{{\fs{gap_size}\1a&HFF&\4a&HFF&\bord0\shad0}}\h\N{{\r{style_name}\fn{target_font}\fs{target_size}\c{target_colour}\b{bold}}}"
        )
    } else {
        format!(r"\N{{\r{style_name}\fn{target_font}\fs{target_size}\c{target_colour}\b{bold}}}")
    };
    Some(match (source.is_empty(), target.is_empty()) {
        (false, false) => format!(
            r"{{\an2\pos({x},{y})\fn{source_font}\fs{source_size}\c{source_colour}\b{bold}}}{source}{bilingual_separator}{target}"
        ),
        (false, true) => format!(
            r"{{\an2\pos({x},{y})\fn{source_font}\fs{source_size}\c{source_colour}\b{bold}}}{source}"
        ),
        (true, false) => format!(
            r"{{\an2\pos({x},{y})\fn{target_font}\fs{target_size}\c{target_colour}\b{bold}}}{target}"
        ),
        (true, true) => String::new(),
    })
}

fn build_ass(cues: &[BurnCueInput], style: &BurnStyleInput) -> String {
    let mut styles = String::new();
    let mut events = String::new();
    for (index, cue) in cues.iter().enumerate() {
        let cue_style = cue.style.as_ref().unwrap_or(style);
        let style_name = format!("Cue{index}");
        let Some(text) = ass_dialogue_text(cue, cue_style, &style_name) else {
            continue;
        };
        styles.push_str(&ass_style_line(&style_name, cue_style));
        events.push_str(&format!(
            "Dialogue: 0,{},{},{style_name},,0,0,0,,{}\n",
            ass_timestamp(cue.start_ms),
            ass_timestamp(cue.end_ms.max(cue.start_ms + 100.0)),
            text
        ));
    }
    format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nScaledBorderAndShadow: yes\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n{styles}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n{events}"
    )
}

struct DeepSeekConfig {
    api_key: String,
    api_base: String,
    model: String,
}

#[derive(Deserialize)]
struct DeepSeekCompletion {
    choices: Vec<DeepSeekChoice>,
}

#[derive(Deserialize)]
struct DeepSeekChoice {
    message: DeepSeekMessage,
}

#[derive(Deserialize)]
struct DeepSeekMessage {
    content: String,
}

#[derive(Deserialize)]
struct DeepSeekTranslationPayload {
    items: Vec<DeepSeekTranslationItem>,
}

#[derive(Deserialize)]
struct DeepSeekTranslationItem {
    index: usize,
    en: Option<String>,
    zh: String,
    speaker: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubtitleTermReviewPayload {
    #[serde(default)]
    verified_terms: Vec<String>,
    #[serde(default)]
    corrections: Vec<SubtitleTermCorrection>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubtitleTermCorrection {
    wrong: String,
    correct: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewedSubtitleContext {
    source_context: VideoSourceContext,
    corrections: Vec<SubtitleTermCorrection>,
}

async fn next_lossy_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
) -> std::io::Result<Option<String>> {
    buffer.clear();
    let bytes_read = reader.read_until(b'\n', buffer).await?;
    if bytes_read == 0 {
        return Ok(None);
    }
    while matches!(buffer.last(), Some(b'\n' | b'\r')) {
        buffer.pop();
    }
    Ok(Some(String::from_utf8_lossy(buffer).into_owned()))
}

async fn find_downloaded_video(directory: &Path, video_id: &str) -> Option<std::path::PathBuf> {
    let mut entries = tokio::fs::read_dir(directory).await.ok()?;
    let bracketed_id = format!("[{video_id}]");
    let mut fallback = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        if !matches!(
            extension.as_deref(),
            Some("mp4" | "mkv" | "webm" | "mov" | "m4v")
        ) {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if stem == video_id {
            return Some(path);
        }
        if file_name.contains(&bracketed_id) {
            fallback = Some(path);
        }
    }
    fallback
}

#[cfg(test)]
fn strip_caption_markup(value: &str) -> String {
    let mut result = String::new();
    let mut inside_tag = false;
    for character in value.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => result.push(character),
            _ => {}
        }
    }
    result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
fn srt_blocks(content: &str) -> Vec<(String, String)> {
    content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split("\n\n")
        .filter_map(|block| {
            let lines = block.lines().collect::<Vec<_>>();
            let timing_index = lines.iter().position(|line| line.contains("-->"))?;
            let header = lines[..=timing_index].join("\n");
            let text = strip_caption_markup(&lines[timing_index + 1..].join("\n"));
            (!text.is_empty()).then_some((header, text))
        })
        .collect()
}

fn parse_env_file(path: &Path) -> HashMap<String, String> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return None;
            }
            let (key, value) = trimmed.split_once('=')?;
            let value = value
                .trim()
                .trim_matches(|character| character == '"' || character == '\'')
                .to_string();
            Some((key.trim().to_string(), value))
        })
        .collect()
}

fn deepseek_config(app: &AppHandle) -> Result<DeepSeekConfig, String> {
    let environment_key = std::env::var("DEEPSEEK_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty());
    if let Some(api_key) = environment_key {
        return Ok(DeepSeekConfig {
            api_key,
            api_base: std::env::var("DEEPSEEK_API_BASE")
                .unwrap_or_else(|_| "https://api.deepseek.com".to_string())
                .trim_end_matches('/')
                .to_string(),
            model: std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-chat".to_string()),
        });
    }

    let config_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位桌面端配置目录：{error}"))?
        .join(".env.local");
    let mut candidates = vec![config_path.clone()];
    candidates.extend(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .map(|directory| directory.join(".env.local")),
    );
    if let Ok(current_directory) = std::env::current_dir() {
        candidates.extend(
            current_directory
                .ancestors()
                .map(|directory| directory.join(".env.local")),
        );
    }

    for candidate in candidates {
        let values = parse_env_file(&candidate);
        let Some(api_key) = values
            .get("DEEPSEEK_API_KEY")
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        if candidate != config_path && !config_path.exists() {
            if let Some(parent) = config_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::copy(&candidate, &config_path);
        }
        return Ok(DeepSeekConfig {
            api_key: api_key.to_string(),
            api_base: values
                .get("DEEPSEEK_API_BASE")
                .cloned()
                .unwrap_or_else(|| "https://api.deepseek.com".to_string())
                .trim_end_matches('/')
                .to_string(),
            model: values
                .get("DEEPSEEK_MODEL")
                .cloned()
                .unwrap_or_else(|| "deepseek-chat".to_string()),
        });
    }

    Err(
        "没有找到 DeepSeek API 配置，请在桌面端配置目录的 .env.local 中设置 DEEPSEEK_API_KEY"
            .to_string(),
    )
}

fn parse_deepseek_json(content: &str) -> Result<DeepSeekTranslationPayload, String> {
    let mut cleaned = content.trim();
    if let Some(value) = cleaned.strip_prefix("```json") {
        cleaned = value;
    } else if let Some(value) = cleaned.strip_prefix("```") {
        cleaned = value;
    }
    if let Some(value) = cleaned.trim().strip_suffix("```") {
        cleaned = value;
    }
    serde_json::from_str(cleaned.trim())
        .map_err(|error| format!("DeepSeek 返回的翻译不是有效 JSON：{error}"))
}

fn parse_term_review_json(content: &str) -> Result<SubtitleTermReviewPayload, String> {
    let mut cleaned = content.trim();
    if let Some(value) = cleaned.strip_prefix("```json") {
        cleaned = value;
    } else if let Some(value) = cleaned.strip_prefix("```") {
        cleaned = value;
    }
    if let Some(value) = cleaned.trim().strip_suffix("```") {
        cleaned = value;
    }
    serde_json::from_str(cleaned.trim())
        .map_err(|error| format!("DeepSeek 返回的专名审校不是有效 JSON：{error}"))
}

#[tauri::command]
async fn review_youtube_subtitle_context(
    app: AppHandle,
    cues: Vec<TranslationCueInput>,
    source_context: VideoSourceContext,
) -> Result<ReviewedSubtitleContext, String> {
    if cues.is_empty() {
        return Ok(ReviewedSubtitleContext {
            source_context,
            corrections: Vec::new(),
        });
    }
    let config = deepseek_config(&app)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent("LingoCast-Studio/0.8")
        .build()
        .map_err(|error| format!("无法初始化字幕专名审校：{error}"))?;
    let transcript = cues
        .iter()
        .enumerate()
        .map(|(index, cue)| serde_json::json!({ "index": index, "english": cue.source_text }))
        .collect::<Vec<_>>();
    let response = client
        .post(format!("{}/chat/completions", config.api_base))
        .bearer_auth(&config.api_key)
        .json(&serde_json::json!({
            "model": &config.model,
            "temperature": 0.0,
            "max_tokens": 5000,
            "thinking": { "type": "disabled" },
            "response_format": { "type": "json_object" },
            "messages": [
                { "role": "system", "content": TERM_REVIEW_SYSTEM_PROMPT },
                {
                    "role": "user",
                    "content": serde_json::to_string(&serde_json::json!({
                        "videoContext": {
                            "title": &source_context.title,
                            "channel": &source_context.channel,
                            "description": &source_context.description,
                        },
                        "verifiedTerms": &source_context.verified_terms,
                        "transcript": transcript,
                    })).unwrap_or_default()
                }
            ]
        }))
        .send()
        .await
        .map_err(|error| format!("DeepSeek 专名审校请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "DeepSeek 专名审校返回 HTTP {}：{}",
            status,
            detail.chars().take(300).collect::<String>()
        ));
    }
    let completion = response
        .json::<DeepSeekCompletion>()
        .await
        .map_err(|error| format!("无法读取 DeepSeek 专名审校响应：{error}"))?;
    let content = completion
        .choices
        .first()
        .map(|choice| choice.message.content.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "DeepSeek 专名审校没有返回内容".to_string())?;
    let reviewed = parse_term_review_json(content)?;
    let all_source = cues
        .iter()
        .map(|cue| cue.source_text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let mut verified_terms = source_context.verified_terms.clone();
    for term in reviewed.verified_terms {
        let term = term.trim();
        if !term.is_empty()
            && term.chars().count() <= 100
            && !verified_terms
                .iter()
                .any(|item| item.eq_ignore_ascii_case(term))
        {
            verified_terms.push(term.to_string());
        }
    }
    let corrections = reviewed
        .corrections
        .into_iter()
        .filter_map(|item| {
            let wrong = item.wrong.trim();
            let correct = item.correct.trim();
            (wrong.chars().count() >= 2
                && wrong.chars().count() <= 100
                && correct.chars().count() <= 100
                && !wrong.eq_ignore_ascii_case(correct)
                && all_source.contains(wrong))
            .then(|| SubtitleTermCorrection {
                wrong: wrong.to_string(),
                correct: correct.to_string(),
            })
        })
        .collect();
    Ok(ReviewedSubtitleContext {
        source_context: VideoSourceContext {
            verified_terms,
            ..source_context
        },
        corrections,
    })
}

async fn request_deepseek_translations(
    client: &reqwest::Client,
    config: &DeepSeekConfig,
    label: &str,
    payload: serde_json::Value,
) -> Result<Vec<DeepSeekTranslationItem>, String> {
    let response = client
        .post(format!("{}/chat/completions", config.api_base))
        .bearer_auth(&config.api_key)
        .json(&serde_json::json!({
            "model": &config.model,
            "temperature": 0.1,
            "max_tokens": 5000,
            "thinking": { "type": "disabled" },
            "response_format": { "type": "json_object" },
            "messages": [
                {
                    "role": "system",
                    "content": TRANSLATION_SYSTEM_PROMPT
                },
                {
                    "role": "user",
                    "content": serde_json::to_string(&payload).unwrap_or_default()
                }
            ]
        }))
        .send()
        .await
        .map_err(|error| format!("DeepSeek {label}请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "DeepSeek {label}返回 HTTP {}：{}",
            status,
            detail.chars().take(300).collect::<String>()
        ));
    }
    let completion = response
        .json::<DeepSeekCompletion>()
        .await
        .map_err(|error| format!("无法读取 DeepSeek {label}响应：{error}"))?;
    let content = completion
        .choices
        .first()
        .map(|choice| choice.message.content.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("DeepSeek {label}没有返回翻译内容"))?;
    Ok(parse_deepseek_json(content)?.items)
}

#[tauri::command]
async fn translate_subtitles(
    app: AppHandle,
    cues: Vec<TranslationCueInput>,
    source_context: Option<VideoSourceContext>,
) -> Result<Vec<TranslatedSubtitleCue>, String> {
    if cues.is_empty() {
        return Ok(Vec::new());
    }
    let config = deepseek_config(&app)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent("LingoCast-Studio/0.4")
        .build()
        .map_err(|error| format!("无法初始化 DeepSeek 翻译：{error}"))?;
    let mut translated = HashMap::new();
    let source_context = source_context.unwrap_or_default();
    const BATCH_SIZE: usize = 20;

    for (batch_index, batch) in cues.chunks(BATCH_SIZE).enumerate() {
        let batch_start = batch_index * BATCH_SIZE;
        let context_start = batch_start.saturating_sub(3);
        let context_end = (batch_start + batch.len() + 3).min(cues.len());
        let context = cues[context_start..context_end]
            .iter()
            .enumerate()
            .map(|(offset, cue)| {
                serde_json::json!({
                    "index": context_start + offset,
                    "english": cue.source_text,
                })
            })
            .collect::<Vec<_>>();
        let mut missing = (batch_start..batch_start + batch.len()).collect::<Vec<_>>();
        for attempt in 0..3 {
            if missing.is_empty() {
                break;
            }
            let pending = missing
                .iter()
                .map(|index| {
                    serde_json::json!({
                        "index": index,
                        "english": cues[*index].source_text,
                    })
                })
                .collect::<Vec<_>>();
            let payload = serde_json::json!({
                "targetIndices": &missing,
                "videoContext": {
                    "title": &source_context.title,
                    "channel": &source_context.channel,
                    "description": &source_context.description,
                },
                "verifiedTerms": &source_context.verified_terms,
                "context": &context,
                "transcript": pending,
            });
            let label = if attempt == 0 {
                format!(
                    "第 {}/{} 批",
                    batch_index + 1,
                    cues.len().div_ceil(BATCH_SIZE)
                )
            } else {
                format!("第 {} 批缺失项重试 {attempt}/2", batch_index + 1)
            };
            for item in request_deepseek_translations(&client, &config, &label, payload).await? {
                if item.index >= batch_start
                    && item.index < batch_start + batch.len()
                    && !item.zh.trim().is_empty()
                {
                    translated.insert(item.index, item);
                }
            }
            missing.retain(|index| !translated.contains_key(index));
        }

        for index in missing.clone() {
            let payload = serde_json::json!({
                "targetIndices": [index],
                "videoContext": {
                    "title": &source_context.title,
                    "channel": &source_context.channel,
                    "description": &source_context.description,
                },
                "verifiedTerms": &source_context.verified_terms,
                "context": &context,
                "transcript": [{
                    "index": index,
                    "english": cues[index].source_text,
                }],
            });
            let label = format!("第 {} 批第 {} 条单独重试", batch_index + 1, index + 1);
            for item in request_deepseek_translations(&client, &config, &label, payload).await? {
                if item.index == index && !item.zh.trim().is_empty() {
                    translated.insert(item.index, item);
                }
            }
        }
        missing.retain(|index| !translated.contains_key(index));
        if !missing.is_empty() {
            return Err(format!(
                "DeepSeek 第 {} 批在重试后仍缺少字幕编号：{}",
                batch_index + 1,
                missing
                    .iter()
                    .map(|index| (index + 1).to_string())
                    .collect::<Vec<_>>()
                    .join("、")
            ));
        }
    }

    cues.into_iter()
        .enumerate()
        .map(|(index, cue)| {
            let item = translated
                .remove(&index)
                .ok_or_else(|| format!("DeepSeek 缺少第 {} 条字幕", index + 1))?;
            Ok(TranslatedSubtitleCue {
                id: cue.id,
                source_text: item
                    .en
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(cue.source_text),
                target_text: item.zh.trim().to_string(),
                speaker: item.speaker.unwrap_or_default().trim().to_string(),
            })
        })
        .collect()
}

fn validate_youtube_url(value: &str) -> Result<Url, String> {
    let parsed = Url::parse(value.trim()).map_err(|_| "请输入有效的 YouTube 链接".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持 http 或 https 链接".to_string());
    }
    let host = parsed
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "链接缺少网站地址".to_string())?;
    let is_youtube = host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com");
    if !is_youtube {
        return Err("目前仅支持 YouTube 和 youtu.be 链接".to_string());
    }
    if parsed.path().trim_matches('/').is_empty() {
        return Err("链接中没有找到视频地址".to_string());
    }
    Ok(parsed)
}

fn emit_download_progress(app: &AppHandle, job_id: &str, percent: f64, status: &str, detail: &str) {
    let _ = app.emit(
        "youtube-download-progress",
        YoutubeDownloadProgress {
            job_id: job_id.to_string(),
            percent: percent.clamp(0.0, 100.0),
            status: status.to_string(),
            detail: detail.to_string(),
        },
    );
}

fn youtube_download_error(errors: &[String], used_cookies: bool) -> String {
    let joined = errors.join("\n");
    let normalized = joined.to_ascii_lowercase();
    if normalized.contains("sign in to confirm") || normalized.contains("login_required") {
        return if used_cookies {
            "YouTube 不接受当前登录会话。请点击“打开/刷新登录”，确认专用窗口中能正常播放视频，关闭该窗口后重试；如使用 cookies.txt，则该文件可能已过期。".to_string()
        } else {
            "YouTube 要求进行“确认不是机器人”验证。请选择 Chrome 或 Edge 专用档案，点击“打开/刷新登录”完成一次登录并关闭窗口，然后重试。".to_string()
        };
    }
    if normalized.contains("http error 403") || normalized.contains("forbidden") {
        return "YouTube 拒绝了当前下载请求（HTTP 403）。请先刷新专用浏览器登录；若仍失败，当前代理出口可能被临时限制，请更换节点后重试。".to_string();
    }
    errors
        .last()
        .cloned()
        .unwrap_or_else(|| "YouTube 返回了未知下载错误".to_string())
}

#[derive(Clone)]
enum YoutubeAuthentication {
    CookieFile(PathBuf),
    BrowserProfile(String),
}

fn apply_youtube_authentication(
    command: &mut Command,
    authentication: Option<&YoutubeAuthentication>,
) {
    match authentication {
        Some(YoutubeAuthentication::CookieFile(path)) => {
            command.arg("--cookies").arg(path);
        }
        Some(YoutubeAuthentication::BrowserProfile(profile)) => {
            command.arg("--cookies-from-browser").arg(profile);
        }
        None => {}
    }
}

fn youtube_browser_executable(browser: &str) -> Result<PathBuf, String> {
    let candidates = match browser {
        "chrome" => vec![
            std::env::var_os("PROGRAMFILES")
                .map(PathBuf::from)
                .map(|path| path.join(r"Google\Chrome\Application\chrome.exe")),
            std::env::var_os("PROGRAMFILES(X86)")
                .map(PathBuf::from)
                .map(|path| path.join(r"Google\Chrome\Application\chrome.exe")),
        ],
        "edge" => vec![
            std::env::var_os("PROGRAMFILES(X86)")
                .map(PathBuf::from)
                .map(|path| path.join(r"Microsoft\Edge\Application\msedge.exe")),
            std::env::var_os("PROGRAMFILES")
                .map(PathBuf::from)
                .map(|path| path.join(r"Microsoft\Edge\Application\msedge.exe")),
        ],
        _ => return Err("暂只支持 Chrome 或 Edge 专用登录档案".to_string()),
    };
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("没有找到已安装的 {browser} 浏览器"))
}

fn youtube_browser_profile(app: &AppHandle, browser: &str) -> Result<(PathBuf, String), String> {
    if !matches!(browser, "chrome" | "edge") {
        return Err("无效的 YouTube 登录浏览器".to_string());
    }
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位 YouTube 登录档案目录：{error}"))?
        .join("youtube-browser-profiles")
        .join(browser);
    let yt_dlp_profile = format!("{browser}:{}", root.join("Default").to_string_lossy());
    Ok((root, yt_dlp_profile))
}

#[tauri::command]
async fn open_youtube_login(app: AppHandle, browser: String) -> Result<(), String> {
    let browser = browser.trim().to_ascii_lowercase();
    let executable = youtube_browser_executable(&browser)?;
    let (profile_root, _) = youtube_browser_profile(&app, &browser)?;
    tokio::fs::create_dir_all(&profile_root)
        .await
        .map_err(|error| format!("无法创建 YouTube 登录档案：{error}"))?;

    let mut command = Command::new(executable);
    command
        .arg(format!(
            "--user-data-dir={}",
            profile_root.to_string_lossy()
        ))
        .args([
            "--profile-directory=Default",
            "--no-first-run",
            "--no-default-browser-check",
            "https://www.youtube.com/",
        ]);
    command
        .spawn()
        .map_err(|error| format!("无法打开 YouTube 专用登录窗口：{error}"))?;
    Ok(())
}

async fn download_youtube_thumbnail(
    url: &Url,
    output_template: &str,
    authentication: Option<&YoutubeAuthentication>,
) -> Result<(), String> {
    let mut command = Command::new("yt-dlp");
    command
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .args([
            "--skip-download",
            "--no-playlist",
            "--encoding",
            "utf-8",
            "--windows-filenames",
            "--write-thumbnail",
            "--convert-thumbnails",
            "jpg",
            "--output",
            output_template,
            url.as_str(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    apply_youtube_authentication(&mut command, authentication);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    let status = command
        .status()
        .await
        .map_err(|error| format!("无法启动 YouTube 封面下载：{error}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "YouTube 封面下载失败".to_string())
}

#[tauri::command]
async fn download_youtube(
    app: AppHandle,
    url: String,
    job_id: String,
    cookie_path: Option<String>,
    browser_profile: Option<String>,
) -> Result<DownloadedVideo, String> {
    let parsed = validate_youtube_url(&url)?;
    let cookie_path = if let Some(value) = cookie_path.filter(|value| !value.trim().is_empty()) {
        let path = tokio::fs::canonicalize(value.trim())
            .await
            .map_err(|_| "找不到所选的 cookies.txt，请重新选择文件".to_string())?;
        if !path.is_file() {
            return Err("所选 cookies.txt 不是有效文件，请重新选择".to_string());
        }
        Some(path)
    } else {
        None
    };
    let browser_authentication = if cookie_path.is_none() {
        if let Some(browser) = browser_profile.filter(|value| !value.trim().is_empty()) {
            let (_, profile) = youtube_browser_profile(&app, &browser.trim().to_ascii_lowercase())?;
            Some(YoutubeAuthentication::BrowserProfile(profile))
        } else {
            None
        }
    } else {
        None
    };
    let authentication = cookie_path
        .clone()
        .map(YoutubeAuthentication::CookieFile)
        .or(browser_authentication);
    let download_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位本地下载目录：{error}"))?
        .join("downloads");
    tokio::fs::create_dir_all(&download_dir)
        .await
        .map_err(|error| format!("无法创建下载目录：{error}"))?;

    let output_template = download_dir
        .join("%(title).150B [%(id)s].%(ext)s")
        .to_string_lossy()
        .into_owned();
    emit_download_progress(&app, &job_id, 0.0, "正在解析视频", "连接 YouTube");

    let mut command = Command::new("yt-dlp");
    command
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .args([
            "--no-playlist",
            "--encoding",
            "utf-8",
            "--newline",
            "--progress",
            "--windows-filenames",
            "--merge-output-format",
            "mp4",
            "--format",
            "bv*+ba/b",
            "--format-sort",
            "res:1080,vcodec:h264,acodec:aac",
            "--retries",
            "10",
            "--fragment-retries",
            "10",
            "--retry-sleep",
            "http:linear=1::5",
            "--progress-template",
            "download:lingocast-progress:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
            "--print",
            "after_move:lingocast-file:%(filepath)s",
            "--print",
            "video:lingocast-title:%(title)j",
            "--print",
            "video:lingocast-id:%(id)s",
            "--print",
            "video:lingocast-description:%(description)j",
            "--print",
            "video:lingocast-channel:%(channel)j",
            "--output",
            &output_template,
            parsed.as_str(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_youtube_authentication(&mut command, authentication.as_ref());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "没有找到 yt-dlp，请先安装 yt-dlp 后重试".to_string()
        } else {
            format!("无法启动视频下载：{error}")
        }
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取下载进度".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取下载错误".to_string())?;
    let progress_app = app.clone();
    let progress_job_id = job_id.clone();

    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        let mut downloaded_path = None;
        let mut title = None;
        let mut video_id = None;
        let mut description = None;
        let mut channel = None;
        while let Some(line) = next_lossy_line(&mut reader, &mut buffer)
            .await
            .map_err(|error| error.to_string())?
        {
            if let Some(payload) = line.strip_prefix(PROGRESS_PREFIX) {
                let mut fields = payload.splitn(3, '|');
                let percent = fields
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .trim_end_matches('%')
                    .parse::<f64>()
                    .unwrap_or(0.0);
                let speed = fields.next().unwrap_or_default().trim();
                let eta = fields.next().unwrap_or_default().trim();
                let detail = match (speed.is_empty(), eta.is_empty()) {
                    (false, false) => format!("{speed} · 剩余 {eta}"),
                    (false, true) => speed.to_string(),
                    _ => "正在下载".to_string(),
                };
                emit_download_progress(
                    &progress_app,
                    &progress_job_id,
                    percent * 0.9,
                    "正在下载视频",
                    &detail,
                );
            } else if let Some(path) = line.strip_prefix(FILE_PREFIX) {
                downloaded_path = Some(path.trim().to_string());
            } else if let Some(value) = line.strip_prefix(TITLE_PREFIX) {
                let encoded = value.trim();
                title = serde_json::from_str::<String>(encoded)
                    .ok()
                    .or_else(|| Some(encoded.to_string()));
            } else if let Some(value) = line.strip_prefix(ID_PREFIX) {
                video_id = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix(DESCRIPTION_PREFIX) {
                let encoded = value.trim();
                description = serde_json::from_str::<String>(encoded)
                    .ok()
                    .or_else(|| Some(encoded.to_string()));
            } else if let Some(value) = line.strip_prefix(CHANNEL_PREFIX) {
                let encoded = value.trim();
                channel = serde_json::from_str::<String>(encoded)
                    .ok()
                    .or_else(|| Some(encoded.to_string()));
            }
        }
        Ok::<_, String>((downloaded_path, title, video_id, description, channel))
    });

    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buffer = Vec::new();
        let mut recent = Vec::new();
        while let Some(line) = next_lossy_line(&mut reader, &mut buffer)
            .await
            .map_err(|error| error.to_string())?
        {
            if !line.trim().is_empty() {
                recent.push(line);
                if recent.len() > 8 {
                    recent.remove(0);
                }
            }
        }
        Ok::<_, String>(recent)
    });

    let status = child
        .wait()
        .await
        .map_err(|error| format!("下载进程异常：{error}"))?;
    let (reported_path, title, video_id, description, channel) = stdout_task
        .await
        .map_err(|error| format!("读取下载结果失败：{error}"))??;
    let errors = stderr_task
        .await
        .map_err(|error| format!("读取下载错误失败：{error}"))??;

    if !status.success() {
        return Err(youtube_download_error(&errors, authentication.is_some()));
    }

    let raw_path = if let Some(video_id) = video_id {
        find_downloaded_video(&download_dir, &video_id)
            .await
            .or_else(|| reported_path.as_ref().map(std::path::PathBuf::from))
    } else {
        reported_path.as_ref().map(std::path::PathBuf::from)
    }
    .ok_or_else(|| "下载完成，但没有找到视频文件".to_string())?;
    emit_download_progress(
        &app,
        &job_id,
        91.0,
        "正在保存 YouTube 封面",
        "生成 JPG 封面文件",
    );
    let _ = download_youtube_thumbnail(&parsed, &output_template, authentication.as_ref()).await;
    emit_download_progress(
        &app,
        &job_id,
        92.0,
        "正在获取双语字幕",
        "下载英文和中文字幕轨",
    );
    let mut subtitle_command = Command::new("yt-dlp");
    subtitle_command
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .args([
            "--skip-download",
            "--no-playlist",
            "--encoding",
            "utf-8",
            "--write-subs",
            "--write-auto-subs",
            "--sub-langs",
            "en-orig,en",
            "--sub-format",
            "srt/best",
            "--sleep-subtitles",
            "1",
            "--retries",
            "5",
            "--windows-filenames",
            "--output",
            &output_template,
            parsed.as_str(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    apply_youtube_authentication(&mut subtitle_command, authentication.as_ref());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        subtitle_command.as_std_mut().creation_flags(0x08000000);
    }
    let _ = subtitle_command.status().await;

    let canonical_path = tokio::fs::canonicalize(&raw_path)
        .await
        .map_err(|error| format!("无法打开下载的视频：{error}"))?;
    let fallback_name = raw_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("YouTube 视频")
        .to_string();
    let name = title
        .clone()
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_name);
    emit_download_progress(&app, &job_id, 99.0, "正在整理字幕", "合并中英文字幕轨");

    let mut subtitles = Vec::new();
    let video_stem = canonical_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let subtitle_prefix = format!("{video_stem}.");
    if let Some(parent) = canonical_path.parent() {
        let mut entries = tokio::fs::read_dir(parent)
            .await
            .map_err(|error| format!("无法读取字幕目录：{error}"))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| format!("无法读取字幕文件：{error}"))?
        {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(language) = file_name
                .strip_prefix(&subtitle_prefix)
                .and_then(|value| value.strip_suffix(".srt"))
            else {
                continue;
            };
            if language.is_empty() {
                continue;
            }
            if let Ok(content) = tokio::fs::read_to_string(entry.path()).await {
                if !content.trim().is_empty() {
                    subtitles.push(DownloadedSubtitle {
                        language: language.to_string(),
                        content,
                    });
                }
            }
        }
    }
    subtitles.sort_by(|left, right| left.language.cmp(&right.language));
    emit_download_progress(
        &app,
        &job_id,
        100.0,
        "下载完成",
        "英文字幕已准备，等待 DeepSeek 翻译",
    );

    Ok(DownloadedVideo {
        path: canonical_path.to_string_lossy().into_owned(),
        name,
        subtitles,
        source_context: VideoSourceContext {
            title: title.unwrap_or_default(),
            description: description.unwrap_or_default(),
            channel: channel.unwrap_or_default(),
            verified_terms: Vec::new(),
        },
    })
}

async fn write_overlay_timeline(
    temp_dir: &Path,
    overlays: &[BurnOverlayInput],
    blank_png_base64: &str,
    duration_ms: f64,
) -> Result<PathBuf, String> {
    let blank = BASE64
        .decode(blank_png_base64)
        .map_err(|error| format!("无法解码透明字幕图层：{error}"))?;
    let blank_path = temp_dir.join("overlay-blank.png");
    tokio::fs::write(&blank_path, blank)
        .await
        .map_err(|error| format!("无法写入透明字幕图层：{error}"))?;

    let mut ordered = overlays.to_vec();
    ordered.sort_by(|left, right| {
        left.start_ms
            .partial_cmp(&right.start_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut cursor_ms = 0.0_f64;
    let mut segments: Vec<(String, f64)> = Vec::new();
    for (index, overlay) in ordered.iter().enumerate() {
        let start_ms = overlay.start_ms.max(0.0);
        let end_ms = overlay.end_ms.max(start_ms + 10.0).min(duration_ms);
        if end_ms <= cursor_ms {
            continue;
        }
        if start_ms > cursor_ms {
            segments.push(("overlay-blank.png".to_string(), start_ms - cursor_ms));
            cursor_ms = start_ms;
        }
        let image_name = format!("overlay-{index:05}.png");
        let image = BASE64
            .decode(&overlay.png_base64)
            .map_err(|error| format!("无法解码第 {} 条字幕图层：{error}", index + 1))?;
        tokio::fs::write(temp_dir.join(&image_name), image)
            .await
            .map_err(|error| format!("无法写入第 {} 条字幕图层：{error}", index + 1))?;
        let visible_start = cursor_ms.max(start_ms);
        segments.push((image_name, end_ms - visible_start));
        cursor_ms = end_ms;
    }
    if cursor_ms < duration_ms {
        segments.push(("overlay-blank.png".to_string(), duration_ms - cursor_ms));
    }
    if segments.is_empty() {
        segments.push(("overlay-blank.png".to_string(), duration_ms.max(10.0)));
    }

    let mut concat = String::from("ffconcat version 1.0\n");
    for (file_name, segment_duration_ms) in &segments {
        concat.push_str(&format!(
            "file '{file_name}'\nduration {:.6}\n",
            (segment_duration_ms / 1000.0).max(0.001)
        ));
    }
    concat.push_str(&format!("file '{}'\n", segments.last().unwrap().0));
    let concat_path = temp_dir.join("overlay.ffconcat");
    tokio::fs::write(&concat_path, concat)
        .await
        .map_err(|error| format!("无法生成字幕图层时间轴：{error}"))?;
    Ok(concat_path)
}

fn youtube_id_from_video_path(video_path: &str) -> Option<String> {
    let stem = Path::new(video_path).file_stem()?.to_string_lossy();
    let open = stem.rfind('[')?;
    let candidate = stem.get(open + 1..)?.strip_suffix(']')?;
    (candidate.len() == 11
        && candidate.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        }))
    .then(|| candidate.to_string())
}

async fn find_local_youtube_cover(video_path: &str, video_id: &str) -> Option<PathBuf> {
    let parent = Path::new(video_path).parent()?;
    let video_stem = Path::new(video_path).file_stem()?.to_string_lossy();
    let mut entries = tokio::fs::read_dir(parent).await.ok()?;
    let mut candidates = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if stem == video_stem || stem.contains(&format!("[{video_id}]")) {
            let score = match extension.as_str() {
                "jpg" | "jpeg" => 0,
                _ => 1,
            };
            candidates.push((score, path));
        }
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    candidates.into_iter().next().map(|(_, path)| path)
}

async fn copy_cover_as_jpg(source: &Path, destination: &Path) -> Result<(), String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "jpg" | "jpeg") {
        tokio::fs::copy(source, destination)
            .await
            .map(|_| ())
            .map_err(|error| format!("无法复制 YouTube 封面：{error}"))
    } else {
        let mut command = Command::new("ffmpeg");
        command.args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &source.to_string_lossy(),
            "-frames:v",
            "1",
            &destination.to_string_lossy(),
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.as_std_mut().creation_flags(0x08000000);
        }
        let status = command
            .status()
            .await
            .map_err(|error| format!("无法转换 YouTube 封面：{error}"))?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "YouTube 封面转换为 JPG 失败".to_string())
    }
}

async fn export_youtube_cover(
    video_path: &str,
    output_path: &str,
) -> Result<Option<String>, String> {
    let Some(video_id) = youtube_id_from_video_path(video_path) else {
        return Ok(None);
    };
    let output_directory = Path::new(output_path)
        .parent()
        .ok_or_else(|| "无法定位烧录视频的导出目录".to_string())?;
    let cover_name = format!("YouTube_{video_id}_cover.jpg");
    let destination = output_directory.join(&cover_name);
    if destination.is_file() {
        return Ok(Some(destination.to_string_lossy().into_owned()));
    }
    if let Some(local_cover) = find_local_youtube_cover(video_path, &video_id).await {
        copy_cover_as_jpg(&local_cover, &destination).await?;
        return Ok(Some(destination.to_string_lossy().into_owned()));
    }
    let existing = Path::new(DEFAULT_EXPORT_DIRECTORY).join(&cover_name);
    if existing.is_file() {
        copy_cover_as_jpg(&existing, &destination).await?;
        return Ok(Some(destination.to_string_lossy().into_owned()));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("无法初始化 YouTube 封面下载：{error}"))?;
    for quality in ["maxresdefault", "hqdefault"] {
        let url = format!("https://img.youtube.com/vi/{video_id}/{quality}.jpg");
        let Ok(response) = client.get(url).send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(bytes) = response.bytes().await else {
            continue;
        };
        if bytes.len() > 1_000 && tokio::fs::write(&destination, bytes).await.is_ok() {
            return Ok(Some(destination.to_string_lossy().into_owned()));
        }
    }
    let video_url = Url::parse(&format!("https://www.youtube.com/watch?v={video_id}"))
        .map_err(|error| format!("无法生成 YouTube 封面地址：{error}"))?;
    let cover_template = output_directory
        .join(format!("YouTube_{video_id}_cover.%(ext)s"))
        .to_string_lossy()
        .into_owned();
    let _ = download_youtube_thumbnail(&video_url, &cover_template, None).await;
    if destination.is_file() {
        return Ok(Some(destination.to_string_lossy().into_owned()));
    }
    Err("没有找到本地封面，联网获取 YouTube 封面也失败".to_string())
}

async fn run_burn_video<F>(
    video_path: String,
    output_path: String,
    cues: Vec<BurnCueInput>,
    overlays: Vec<BurnOverlayInput>,
    blank_png_base64: String,
    style: BurnStyleInput,
    duration_ms: f64,
    mut on_progress: F,
) -> Result<BurnedVideoOutput, String>
where
    F: FnMut(f64),
{
    let input = Path::new(&video_path);
    if !input.is_file() {
        return Err("找不到原视频文件，请重新导入视频".to_string());
    }
    if cues.is_empty() {
        return Err("当前项目没有可烧录的字幕".to_string());
    }
    if input == Path::new(&output_path) {
        return Err("导出路径不能覆盖原视频，请选择新的文件名".to_string());
    }

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let temp_dir =
        std::env::temp_dir().join(format!("lingocast-burn-{}-{unique}", std::process::id()));
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|error| format!("无法创建烧录临时目录：{error}"))?;
    let use_raster_overlays = !overlays.is_empty() && !blank_png_base64.is_empty();
    if use_raster_overlays {
        write_overlay_timeline(&temp_dir, &overlays, &blank_png_base64, duration_ms).await?;
    } else {
        let ass_path = temp_dir.join("subtitles.ass");
        tokio::fs::write(&ass_path, build_ass(&cues, &style))
            .await
            .map_err(|error| format!("无法生成烧录字幕：{error}"))?;
    }

    let mut command = Command::new("ffmpeg");
    command.current_dir(&temp_dir).args([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        &video_path,
    ]);
    if use_raster_overlays {
        command.args([
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            "overlay.ffconcat",
            "-filter_complex",
            "[1:v][0:v]scale2ref=w=ref_w:h=ref_h[subtitle][base];[base][subtitle]overlay=0:0:format=auto:eof_action=pass[video]",
            "-map",
            "[video]",
            "-map",
            "0:a?",
        ]);
    } else {
        command.args(["-vf", "ass=subtitles.ass"]);
    }
    command
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
            &output_path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&temp_dir).await;
            return Err(format!("无法启动 FFmpeg：{error}"));
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 FFmpeg 烧录进度".to_string())?;
    let mut stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.read_to_end(&mut bytes).await;
        }
        bytes
    });
    let mut reader = BufReader::new(stdout);
    let mut line_buffer = Vec::new();
    let mut last_percent = -1.0;
    while let Some(line) = next_lossy_line(&mut reader, &mut line_buffer)
        .await
        .map_err(|error| format!("无法读取 FFmpeg 烧录进度：{error}"))?
    {
        let elapsed_micros = line
            .strip_prefix("out_time_us=")
            .or_else(|| line.strip_prefix("out_time_ms="))
            .and_then(|value| value.parse::<f64>().ok());
        if let Some(elapsed_micros) = elapsed_micros {
            let percent = if duration_ms > 0.0 {
                (elapsed_micros / (duration_ms * 1_000.0) * 100.0).clamp(0.0, 99.5)
            } else {
                0.0
            };
            if percent - last_percent >= 0.2 {
                last_percent = percent;
                on_progress(percent);
            }
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|error| format!("等待 FFmpeg 完成时失败：{error}"))?;
    let stderr_bytes = stderr_task.await.unwrap_or_default();
    let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr_bytes);
        let tail = detail
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("视频烧录失败：{tail}"));
    }
    let (cover_path, cover_error) = match export_youtube_cover(&video_path, &output_path).await {
        Ok(path) => (path, None),
        Err(error) => (None, Some(error)),
    };
    on_progress(100.0);
    Ok(BurnedVideoOutput {
        video_path: output_path,
        cover_path,
        cover_error,
    })
}

#[tauri::command]
async fn burn_video(
    app: AppHandle,
    video_path: String,
    output_path: String,
    cues: Vec<BurnCueInput>,
    overlays: Vec<BurnOverlayInput>,
    blank_png_base64: String,
    style: BurnStyleInput,
    duration_ms: f64,
    job_id: String,
) -> Result<BurnedVideoOutput, String> {
    let progress_app = app.clone();
    let progress_job_id = job_id.clone();
    let _ = app.emit(
        "video-burn-progress",
        VideoBurnProgress {
            job_id,
            percent: 0.0,
        },
    );
    run_burn_video(
        video_path,
        output_path,
        cues,
        overlays,
        blank_png_base64,
        style,
        duration_ms,
        move |percent| {
            let _ = progress_app.emit(
                "video-burn-progress",
                VideoBurnProgress {
                    job_id: progress_job_id.clone(),
                    percent,
                },
            );
        },
    )
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_studio_schema",
            sql: r#"
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                video_path TEXT NOT NULL,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS cues (
                id TEXT PRIMARY KEY NOT NULL,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                speaker TEXT NOT NULL DEFAULT '',
                source_text TEXT NOT NULL DEFAULT '',
                target_text TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft',
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS cues_project_position_idx
                ON cues(project_id, position);

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY NOT NULL,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                stage TEXT NOT NULL,
                progress INTEGER NOT NULL DEFAULT 0,
                manifest_path TEXT,
                error_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_project_subtitle_style",
            sql: r#"
            ALTER TABLE projects ADD COLUMN subtitle_style TEXT NOT NULL DEFAULT '{}';
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add_cue_subtitle_style",
            sql: r#"
            ALTER TABLE cues ADD COLUMN subtitle_style TEXT NOT NULL DEFAULT '{}';
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add_project_source_context",
            sql: r#"
            CREATE TABLE IF NOT EXISTS project_contexts (
                project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                source_context TEXT NOT NULL DEFAULT '{}'
            );
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_project_burned_at",
            sql: r#"
            ALTER TABLE projects ADD COLUMN burned_at TEXT;
        "#,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            download_youtube,
            open_youtube_login,
            review_youtube_subtitle_context,
            translate_subtitles,
            ensure_export_directory,
            burn_video
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:lingocast-studio.db", migrations)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running LingoCast Studio");
}

#[cfg(test)]
mod tests {
    use super::{
        build_ass, export_youtube_cover, find_downloaded_video, next_lossy_line,
        parse_deepseek_json, parse_term_review_json, run_burn_video, safe_file_name, srt_blocks,
        validate_youtube_url, youtube_download_error, youtube_id_from_video_path, BurnCueInput,
        BurnOverlayInput, BurnStyleInput,
    };
    use std::{
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::io::BufReader;

    #[test]
    fn accepts_common_youtube_urls() {
        assert!(validate_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://youtu.be/dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://music.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
    }

    #[test]
    fn prepares_safe_project_folder_and_recovers_youtube_id() {
        assert_eq!(safe_file_name("Title: Part 1?"), "Title_ Part 1_");
        assert_eq!(
            youtube_id_from_video_path(r"D:\Downloads\Ontario Road Trips [ueu_5SF_gXc].mp4"),
            Some("ueu_5SF_gXc".to_string())
        );
        assert_eq!(youtube_id_from_video_path(r"D:\Videos\local.mp4"), None);
    }

    #[tokio::test]
    async fn exports_cached_youtube_cover_next_to_burned_video() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("lingocast-cover-test-{nonce}"));
        let downloads = directory.join("downloads");
        let exports = directory.join("exports");
        tokio::fs::create_dir_all(&downloads).await.unwrap();
        tokio::fs::create_dir_all(&exports).await.unwrap();
        let video = downloads.join("Example [dQw4w9WgXcQ].mp4");
        let cached_cover = downloads.join("Example [dQw4w9WgXcQ].jpg");
        let output = exports.join("Example.burned.mp4");
        tokio::fs::write(&video, b"video").await.unwrap();
        tokio::fs::write(&cached_cover, b"jpeg fixture")
            .await
            .unwrap();

        let result = export_youtube_cover(
            video.to_string_lossy().as_ref(),
            output.to_string_lossy().as_ref(),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(
            Path::new(&result).file_name().unwrap(),
            "YouTube_dQw4w9WgXcQ_cover.jpg"
        );
        assert_eq!(tokio::fs::read(result).await.unwrap(), b"jpeg fixture");
        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[test]
    fn explains_youtube_bot_checks_without_exposing_raw_logs() {
        let errors = vec!["ERROR: Sign in to confirm you’re not a bot. Use --cookies".to_string()];
        let anonymous = youtube_download_error(&errors, false);
        let authenticated = youtube_download_error(&errors, true);
        assert!(anonymous.contains("专用档案"));
        assert!(anonymous.contains("打开/刷新登录"));
        assert!(authenticated.contains("不接受当前登录会话"));
    }

    #[test]
    fn builds_bilingual_ass_with_real_line_breaks_and_optional_background() {
        let cues = vec![BurnCueInput {
            start_ms: 1_000.0,
            end_ms: 3_000.0,
            source_text: "First line.\nSecond line.".to_string(),
            target_text: "第一行。\n第二行。".to_string(),
            style: None,
        }];
        let mut boxed_style = BurnStyleInput::default();
        boxed_style.source_font_size = 72.0;
        boxed_style.target_font_size = 64.0;
        let mut outlined_style = boxed_style.clone();
        outlined_style.background_enabled = false;
        let boxed = build_ass(&cues, &boxed_style);
        let outlined = build_ass(&cues, &outlined_style);
        assert!(boxed.contains("BorderStyle"));
        assert!(boxed.contains("Arial"));
        assert!(boxed.contains(r"\fs72"));
        assert!(boxed.contains(r"\fs64"));
        assert!(boxed.contains(r"First line.\NSecond line.\N"));
        assert!(boxed.contains(r"\1a&HFF&\4a&HFF&\bord0\shad0"));
        assert!(boxed.contains(r"\rCue0\fnMicrosoft YaHei\fs64"));
        assert!(boxed.contains(",100,100,0,0,3,"));
        assert!(boxed.contains("First line."));
        assert!(boxed.contains("&H61666666"));
        assert!(boxed.contains(r"\pos(960,1026)"));
        assert!(outlined.contains("&HFF000000"));
    }

    #[test]
    fn applies_individual_cue_style_without_an_empty_language_line() {
        let mut individual_style = BurnStyleInput::default();
        individual_style.source_font_size = 80.0;
        individual_style.position_x = 35.0;
        let cues = vec![BurnCueInput {
            start_ms: 0.0,
            end_ms: 1_000.0,
            source_text: "English only".to_string(),
            target_text: "".to_string(),
            style: Some(individual_style),
        }];
        let ass = build_ass(&cues, &BurnStyleInput::default());
        assert!(ass.contains(r"\fs80"));
        assert!(ass.contains(r"\pos(672,1026)"));
        assert!(!ass.contains(r"English only\N"));
        assert_eq!(ass.matches("Dialogue:").count(), 1);
    }

    #[tokio::test]
    #[ignore = "requires FFmpeg"]
    async fn burns_ass_subtitles_into_a_real_mp4() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("lingocast-burn-test-{unique}"));
        std::fs::create_dir_all(&directory).unwrap();
        let input = directory.join("input.mp4");
        let output = directory.join("output.mp4");
        let status = tokio::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=navy:s=640x360:d=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                input.to_str().unwrap(),
            ])
            .status()
            .await
            .unwrap();
        assert!(status.success());
        let mut progress = Vec::new();
        let transparent_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let result = run_burn_video(
            input.to_string_lossy().into_owned(),
            output.to_string_lossy().into_owned(),
            vec![BurnCueInput {
                start_ms: 0.0,
                end_ms: 900.0,
                source_text: "Burned subtitle".to_string(),
                target_text: "烧录字幕".to_string(),
                style: None,
            }],
            vec![BurnOverlayInput {
                start_ms: 0.0,
                end_ms: 900.0,
                png_base64: transparent_png.to_string(),
            }],
            transparent_png.to_string(),
            BurnStyleInput::default(),
            1_000.0,
            |percent| progress.push(percent),
        )
        .await;
        assert!(result.is_ok(), "{result:?}");
        assert!(progress
            .iter()
            .any(|percent| *percent > 0.0 && *percent < 100.0));
        assert!(progress.last().is_some_and(|percent| *percent == 100.0));
        assert!(output.metadata().unwrap().len() > 1_000);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn rejects_non_youtube_and_empty_paths() {
        assert!(validate_youtube_url("https://example.com/watch?v=123").is_err());
        assert!(validate_youtube_url("https://youtube.com/").is_err());
        assert!(validate_youtube_url("not a url").is_err());
    }

    #[test]
    fn extracts_caption_text_without_changing_timing() {
        let blocks = srt_blocks(
            "1\n00:00:01,000 --> 00:00:03,000\n<font color=\"white\">Hello</font> world\n\n2\n00:00:04,000 --> 00:00:05,000\nHow are you?",
        );
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].0, "1\n00:00:01,000 --> 00:00:03,000");
        assert_eq!(blocks[0].1, "Hello world");
    }

    #[test]
    fn parses_fenced_deepseek_translation_json() {
        let payload = parse_deepseek_json(
            "```json\n{\"items\":[{\"index\":0,\"zh\":\"测试译文\",\"speaker\":\"Speaker 1\"}]}\n```",
        )
        .unwrap();
        assert_eq!(payload.items.len(), 1);
        assert_eq!(payload.items[0].index, 0);
        assert_eq!(payload.items[0].zh, "测试译文");
    }

    #[test]
    fn parses_fenced_proper_name_review_json() {
        let payload = parse_term_review_json(
            "```json\n{\"verifiedTerms\":[\"Dylan Cease\"],\"corrections\":[{\"wrong\":\"Dylan C\",\"correct\":\"Dylan Cease\"}]}\n```",
        )
        .unwrap();
        assert_eq!(payload.verified_terms, vec!["Dylan Cease"]);
        assert_eq!(payload.corrections.len(), 1);
        assert_eq!(payload.corrections[0].wrong, "Dylan C");
    }

    #[tokio::test]
    async fn decodes_non_utf8_process_output_without_failing() {
        let bytes = b"lingocast-id:DP89qj1te4k\nlegacy-title:\xff\xfe\n";
        let mut reader = BufReader::new(&bytes[..]);
        let mut buffer = Vec::new();
        assert_eq!(
            next_lossy_line(&mut reader, &mut buffer).await.unwrap(),
            Some("lingocast-id:DP89qj1te4k".to_string())
        );
        let lossy = next_lossy_line(&mut reader, &mut buffer)
            .await
            .unwrap()
            .unwrap();
        assert!(lossy.starts_with("legacy-title:"));
        assert!(lossy.contains('\u{fffd}'));
    }

    #[tokio::test]
    async fn finds_unicode_download_by_youtube_id() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("lingocast-download-test-{nonce}"));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let expected = directory.join("测试标题 📣 [DP89qj1te4k].mp4");
        tokio::fs::write(&expected, b"fixture").await.unwrap();

        let actual = find_downloaded_video(&directory, "DP89qj1te4k").await;

        assert_eq!(actual.as_deref(), Some(expected.as_path()));
        tokio::fs::remove_dir_all(&directory).await.unwrap();
    }
}

//! Opt-in, local filesystem RPC. No network listener or arbitrary code execution.
use serde_json::Value;
use tauri::{AppHandle, Manager};

fn directory(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if std::env::var("LINGOCAST_AUTOMATION").as_deref() != Ok("1") {
        return Err("Automation disabled; start with LINGOCAST_AUTOMATION=1".into());
    }
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("automation");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[tauri::command]
pub async fn automation_duration(app: AppHandle, path: String) -> Result<f64, String> {
    directory(&app)?;
    super::authorize_video_asset(app, path.clone())?;
    super::probe_video_duration_ms(&path).await.map(f64::round)
}

#[tauri::command]
pub fn automation_next(app: AppHandle) -> Result<Option<Value>, String> {
    let path = directory(&app)?;
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let file = entry.path();
        let Some(name) = file.file_name().and_then(|v| v.to_str()) else { continue };
        let Some(id) = name.strip_suffix(".request.json") else { continue };
        if !valid_id(id) { continue; }
        let running = path.join(format!("{id}.running.json"));
        if std::fs::rename(&file, &running).is_err() { continue; }
        let request = std::fs::read(&running)
            .map_err(|e| e.to_string())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string()));
        match request {
            Ok(mut request) if request.is_object() => {
                request["id"] = Value::String(id.to_string());
                return Ok(Some(request));
            }
            Ok(_) => {
                automation_reply(app.clone(), id.to_string(), serde_json::json!({"ok":false,"error":"Request must be an object"}))?;
            }
            Err(error) => {
                automation_reply(app.clone(), id.to_string(), serde_json::json!({"ok":false,"error":error}))?;
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn automation_reply(app: AppHandle, id: String, response: Value) -> Result<(), String> {
    if !valid_id(&id) { return Err("Invalid request id".into()); }
    let path = directory(&app)?;
    let temporary = path.join(format!("{id}.response.tmp"));
    std::fs::write(&temporary, serde_json::to_vec(&response).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, path.join(format!("{id}.response.json"))).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(path.join(format!("{id}.running.json")));
    Ok(())
}

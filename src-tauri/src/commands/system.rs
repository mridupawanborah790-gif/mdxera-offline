use tauri::Manager;

#[tauri::command]
pub fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_local_ip() -> Result<Option<String>, String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    if socket.connect("8.8.8.8:80").is_ok() {
        if let Ok(addr) = socket.local_addr() {
            return Ok(Some(addr.ip().to_string()));
        }
    }
    // Fallback: try connecting to a common local gateway address if internet route is absent
    if socket.connect("192.168.1.1:80").is_ok() {
        if let Ok(addr) = socket.local_addr() {
            return Ok(Some(addr.ip().to_string()));
        }
    }
    Ok(None)
}

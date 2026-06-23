mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::auth::sign_local_token,
            commands::auth::verify_local_token,
            commands::system::get_app_data_dir,
            commands::system::get_local_ip,
        ])
        .setup(|app| {
            use tauri::Manager;
            let app_data = app.path().app_data_dir().expect("app data dir must exist");
            // Ensure all data sub-directories exist on first launch
            for sub in ["db", "config", "auth", "logs"] {
                std::fs::create_dir_all(app_data.join(sub))
                    .expect("failed to create app data subdirectory");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MDXera ERP");
}

//! Docent desktop shell (S13, D25) — a window around the *unchanged* SPA
//! build plus the native portfolio store. There is no second frontend and no
//! JS bridge: the only thing the Rust side tells the page is where its store
//! listens, injected as `window.__DOCENT_API_BASE__` before the first script
//! runs. Everything else the app does, it does exactly as it does on the web.
//!
//! The MCP agent endpoint is deliberately absent — S13 puts agent control on
//! the self-hosted deployment; the desktop serves the watching and reading
//! audiences.

pub mod store;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            // The D17 tree lives under the OS app-data directory, so the
            // portfolio survives reinstalls and is still just files a file
            // manager can open.
            let data_dir = handle.path().app_data_dir()?.join("portfolio");

            let api_base = match store::spawn(data_dir) {
                Ok(store) => {
                    let base = store.base_url();
                    // Held for the process lifetime; dropping it stops the
                    // listener.
                    handle.manage(store);
                    Some(base)
                }
                Err(err) => {
                    // S12 requires graceful degradation: without a store the
                    // portfolio modal says so and file workflows are
                    // unaffected, so a bind failure must not stop the canvas.
                    eprintln!("docent: portfolio store unavailable — {err}");
                    None
                }
            };

            let mut window =
                WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                    .title("Docent")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(960.0, 640.0);

            if let Some(base) = api_base {
                let script = format!(
                    "window.__DOCENT_API_BASE__ = {};",
                    serde_json::to_string(&base)?
                );
                window = window.initialization_script(script.as_str());
            }

            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("docent: failed to start the desktop shell");
}

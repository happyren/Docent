//! Docent desktop shell (S13, D25) — a window around the *unchanged* SPA
//! build plus the native portfolio store. There is no second frontend and no
//! JS bridge: the Rust side announces two facts before the first script runs —
//! that this is the desktop shell, and where its store listens — and afterwards
//! reaches the page only by calling one function the page itself registers.
//! Everything else the app does, it does exactly as it does on the web.
//!
//! On the desktop the actions live in the native menu bar, so the page hides
//! its own copies of them; on the web nothing is injected and the in-canvas
//! menu is the only menu.
//!
//! The MCP agent endpoint is deliberately absent — S13 puts agent control on
//! the self-hosted deployment; the desktop serves the watching and reading
//! audiences.

pub mod store;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

/// The items Docent contributes to the native menu bar. Every one carries the
/// id the page dispatches on, so this list is one half of a contract with
/// `window.__docentMenu` (src/shell/App.tsx) — the ids are matched literally
/// by the test at the bottom of this file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MenuAction {
    Open,
    Save,
    SaveAs,
    Portfolio,
    Present,
    Library,
    Legend,
    Arrange,
    ExportMermaid,
    ExportSidecar,
}

impl MenuAction {
    /// Every action, in menu-bar order.
    const ALL: [Self; 10] = [
        Self::Open,
        Self::Save,
        Self::SaveAs,
        Self::Portfolio,
        Self::Present,
        Self::Library,
        Self::Legend,
        Self::Arrange,
        Self::ExportMermaid,
        Self::ExportSidecar,
    ];

    /// Exhaustive by construction: an action cannot reach the menu without an
    /// id, and an id the page does not know fails the contract test.
    const fn id(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Save => "save",
            Self::SaveAs => "save-as",
            Self::Portfolio => "portfolio",
            Self::Present => "present",
            Self::Library => "library",
            Self::Legend => "legend",
            Self::Arrange => "arrange",
            Self::ExportMermaid => "export-mermaid",
            Self::ExportSidecar => "export-sidecar",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Open => "Open Scene…",
            Self::Save => "Save",
            Self::SaveAs => "Save As…",
            Self::Portfolio => "Portfolio…",
            Self::Present => "Present",
            Self::Library => "Library",
            Self::Legend => "Legend…",
            Self::Arrange => "Arrange Detail Tiers",
            Self::ExportMermaid => "Mermaid…",
            Self::ExportSidecar => "Semantic JSON…",
        }
    }

    /// `CmdOrCtrl` resolves to the platform's own modifier.
    const fn accelerator(self) -> Option<&'static str> {
        match self {
            Self::Open => Some("CmdOrCtrl+O"),
            Self::Save => Some("CmdOrCtrl+S"),
            Self::SaveAs => Some("CmdOrCtrl+Shift+S"),
            Self::Portfolio => Some("CmdOrCtrl+Shift+P"),
            Self::Present => Some("CmdOrCtrl+P"),
            Self::Library => Some("CmdOrCtrl+L"),
            Self::Legend | Self::Arrange | Self::ExportMermaid | Self::ExportSidecar => None,
        }
    }
}

/// The ids the page answers to, derived from the one list above so the menu
/// and the event guard cannot drift apart.
const MENU_IDS: [&str; MenuAction::ALL.len()] = {
    let mut ids = [""; MenuAction::ALL.len()];
    let mut i = 0;
    while i < ids.len() {
        ids[i] = MenuAction::ALL[i].id();
        i += 1;
    }
    ids
};

/// Whether a menu click is Docent's. Predefined items (clipboard, window,
/// quit) carry ids of their own and are the system's business, not the page's.
fn is_docent_menu_id(id: &str) -> bool {
    MENU_IDS.contains(&id)
}

fn item(app: &AppHandle, action: MenuAction) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, action.id(), action.label(), true, action.accelerator())
}

/// The whole menu bar, replacing Tauri's default. Edit is load-bearing rather
/// than decorative: the system webview takes its clipboard commands from the
/// menu, so without those items Cmd/Ctrl+C, +X and +V do nothing in text
/// inputs. Fullscreen, Services and Hide are macOS-only in the menu backend —
/// elsewhere they would render as entries that do nothing.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about = PredefinedMenuItem::about(
        app,
        None,
        Some(AboutMetadata {
            name: Some("Docent".into()),
            version: Some(app.package_info().version.to_string()),
            copyright: app.config().bundle.copyright.clone(),
            credits: Some("Built on Excalidraw. Not affiliated with Excalidraw.".into()),
            ..Default::default()
        }),
    )?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(app, MenuAction::Open)?,
            &item(app, MenuAction::Save)?,
            &item(app, MenuAction::SaveAs)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, MenuAction::Portfolio)?,
            // macOS keeps Quit in the application menu; the others have none.
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(app, MenuAction::Present)?,
            &item(app, MenuAction::Library)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, MenuAction::Legend)?,
            &item(app, MenuAction::Arrange)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let export = Submenu::with_items(
        app,
        "Export",
        true,
        &[
            &item(app, MenuAction::ExportMermaid)?,
            &item(app, MenuAction::ExportSidecar)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            // On macOS the first submenu *is* the application menu; other
            // platforms have no such menu, so About goes under Help there.
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "Docent",
                true,
                &[
                    &about,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &file,
            &edit,
            &view,
            &export,
            &window,
            #[cfg(not(target_os = "macos"))]
            &Submenu::with_items(app, "Help", true, &[&about])?,
        ],
    )
}

pub fn run() {
    tauri::Builder::default()
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if !is_docent_menu_id(id) {
                return;
            }
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            // The ids are the closed const list above — plain ASCII, never
            // user input — so interpolating one is not an injection surface.
            // The guard makes the call a no-op until the page has registered
            // its dispatcher, and after it tears the dispatcher down.
            let _ = window.eval(format!(
                "window.__docentMenu && window.__docentMenu('{id}')"
            ));
        })
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

            // Both facts have to be in place before the SPA's first script
            // runs: the flag decides what chrome the app renders, and the base
            // URL is read at module load. Absent — i.e. on the web — the app
            // is the web app, unchanged.
            let mut script = String::from("window.__DOCENT_DESKTOP__ = true;");
            if let Some(base) = api_base {
                script.push_str(&format!(
                    "window.__DOCENT_API_BASE__ = {};",
                    serde_json::to_string(&base)?
                ));
            }

            WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                .title("Docent")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .initialization_script(script.as_str())
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("docent: failed to start the desktop shell");
}

#[cfg(test)]
mod tests {
    use super::{is_docent_menu_id, MenuAction, MENU_IDS};

    /// The ids `window.__docentMenu` dispatches on (src/shell/App.tsx),
    /// written out literally. A rename on either side should fail here rather
    /// than silently turn a menu item into a no-op.
    const FRONTEND_IDS: [&str; 10] = [
        "open",
        "save",
        "save-as",
        "portfolio",
        "present",
        "library",
        "legend",
        "arrange",
        "export-mermaid",
        "export-sidecar",
    ];

    #[test]
    fn menu_ids_match_the_frontend_contract() {
        assert_eq!(MENU_IDS, FRONTEND_IDS);
    }

    #[test]
    fn every_menu_item_reaches_the_page() {
        for action in MenuAction::ALL {
            assert!(
                is_docent_menu_id(action.id()),
                "{action:?} would click into the void"
            );
        }
    }

    #[test]
    fn predefined_menu_ids_are_left_alone() {
        // Predefined items get numeric ids from the menu backend.
        assert!(!is_docent_menu_id("1000"));
        assert!(!is_docent_menu_id(""));
    }

    #[test]
    fn menu_ids_are_unique() {
        for (i, id) in MENU_IDS.iter().enumerate() {
            assert!(!MENU_IDS[..i].contains(id), "duplicate menu id: {id}");
        }
    }
}

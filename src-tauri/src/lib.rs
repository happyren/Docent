//! Docent desktop shell (S13, D25) — a window around the *unchanged* SPA
//! build plus the native portfolio store. There is no second frontend and no
//! JS bridge: the Rust side announces two facts before the first script runs —
//! that this is the desktop shell, and where its store listens — and afterwards
//! reaches the page only by calling one function the page itself registers.
//! Everything else the app does, it does exactly as it does on the web.
//!
//! On the desktop the actions live in the native menu bar (D109) — File,
//! Diagram, Project — so the page hides its own hamburger and the bar
//! dispatches into the one command table the page already keeps (B4). On the
//! web nothing is injected and the in-canvas menu is the only menu.
//!
//! The MCP agent endpoint (S15, A7) is a loopback pipe: `mcp.rs` accepts
//! JSON-RPC and relays raw bodies to the page, which runs the one shared
//! dispatcher — the shell never grows an agent brain of its own (D34).

pub mod github;
pub mod mcp;
pub mod plugins;
pub mod store;
pub mod sync;
pub mod updates;

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;

use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry};

/// The items Docent contributes to the native menu bar. Almost every one
/// carries the id the page dispatches on, so this list is one half of a
/// contract with `window.__docentMenu` (src/shell/App.tsx) — those ids are
/// matched literally by the test at the bottom of this file.
///
/// The exception is `CheckUpdates`, which the shell answers itself: it has no
/// frontend half at all, so it is listed in `RUST_ONLY_IDS` and deliberately
/// absent from the page's union.
///
/// File reads as it does in a document app, but the document store is the
/// portfolio: Open browses it, Save writes back into it, and the two items
/// that cross to a loose file on disk say so — Import and Export. The three
/// submenus are File, Diagram and Project (D109), and this list is written in
/// that order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MenuAction {
    New,
    Open,
    Import,
    Save,
    SaveAs,
    ExportFile,
    ExportMermaid,
    ExportSidecar,
    Present,
    Library,
    Legend,
    Arrange,
    Tidy,
    DetailMarkers,
    Portfolio,
    ConnectAgent,
    Plugins,
    AgentEdit,
    CheckUpdates,
    AgentEndpoint,
}

impl MenuAction {
    /// Every action, in menu-bar order.
    const ALL: [Self; 20] = [
        Self::New,
        Self::Open,
        Self::Import,
        Self::Save,
        Self::SaveAs,
        Self::ExportFile,
        Self::ExportMermaid,
        Self::ExportSidecar,
        Self::Present,
        Self::Library,
        Self::Legend,
        Self::Arrange,
        Self::Tidy,
        Self::DetailMarkers,
        Self::Portfolio,
        Self::ConnectAgent,
        Self::Plugins,
        Self::AgentEdit,
        Self::CheckUpdates,
        Self::AgentEndpoint,
    ];

    /// Exhaustive by construction: an action cannot reach the menu without an
    /// id, and a page-bound id the page does not know fails the contract test.
    const fn id(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Open => "open",
            Self::Import => "import",
            Self::Save => "save",
            Self::SaveAs => "save-as",
            Self::ExportFile => "export-file",
            Self::ExportMermaid => "export-mermaid",
            Self::ExportSidecar => "export-sidecar",
            Self::Present => "present",
            Self::Library => "library",
            Self::Legend => "legend",
            Self::Arrange => "arrange",
            Self::Tidy => "tidy",
            Self::DetailMarkers => "detail-markers",
            Self::Portfolio => "portfolio",
            Self::ConnectAgent => "connect-agent",
            Self::Plugins => "plugins",
            Self::AgentEdit => "agent-edit",
            Self::CheckUpdates => "check-updates",
            Self::AgentEndpoint => "agent-endpoint",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::New => "New Scene…",
            Self::Open => "Open…",
            Self::Import => "Import Scene File…",
            Self::Save => "Save",
            Self::SaveAs => "Save As…",
            Self::ExportFile => "Export Scene File…",
            Self::ExportMermaid => "Export Mermaid…",
            Self::ExportSidecar => "Export Semantic JSON…",
            Self::Present => "Present",
            Self::Library => "Shape Library",
            Self::Legend => "Legend…",
            Self::Arrange => "Arrange Detail Tiers",
            Self::Tidy => "Tidy Diagram",
            Self::DetailMarkers => "Detail Markers",
            Self::Portfolio => "Portfolio…",
            Self::ConnectAgent => "Connect Agent Bridge",
            Self::Plugins => "Plugins…",
            Self::AgentEdit => "Agent Can Edit",
            Self::CheckUpdates => "Check for Updates…",
            Self::AgentEndpoint => "Agent Endpoint…",
        }
    }

    /// `CmdOrCtrl` resolves to the platform's own modifier.
    const fn accelerator(self) -> Option<&'static str> {
        match self {
            Self::New => Some("CmdOrCtrl+N"),
            Self::Open => Some("CmdOrCtrl+O"),
            Self::Import => Some("CmdOrCtrl+Shift+O"),
            Self::Save => Some("CmdOrCtrl+S"),
            Self::SaveAs => Some("CmdOrCtrl+Shift+S"),
            Self::Present => Some("CmdOrCtrl+P"),
            Self::Library => Some("CmdOrCtrl+L"),
            // Format Document's chord, as every editor has it (D73); Alt is
            // Option on macOS.
            Self::Tidy => Some("Alt+Shift+F"),
            // Checking for updates is a thing you go looking for, not a thing
            // you reach for mid-draw, so it claims no chord.
            Self::ExportFile
            | Self::Legend
            | Self::Arrange
            | Self::DetailMarkers
            | Self::Portfolio
            | Self::ConnectAgent
            | Self::Plugins
            | Self::AgentEdit
            | Self::ExportMermaid
            | Self::ExportSidecar
            | Self::CheckUpdates
            | Self::AgentEndpoint => None,
        }
    }
}

/// The native dialogs, hopped to the main thread: macOS refuses to raise one
/// anywhere else, and the store answers on its own thread. Only the dialog
/// crosses over — reading and writing the file stays on the store's thread, so
/// the runloop is never held by disk I/O.
struct NativeDialog {
    app: AppHandle,
}

impl NativeDialog {
    fn on_main<T: Send + 'static>(&self, work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (answer, wait) = mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let _ = answer.send(work());
            })
            .ok()?;
        // The send happens after the dialog closes, so this blocks for exactly
        // as long as the user takes to answer it.
        wait.recv().ok()
    }
}

impl store::Dialogs for NativeDialog {
    fn pick_open(&self) -> Option<PathBuf> {
        self.on_main(|| {
            rfd::FileDialog::new()
                .set_title("Import Scene File")
                .add_filter("Excalidraw scene", &["excalidraw", "json"])
                .pick_file()
        })
        .flatten()
    }

    fn pick_save(&self, suggested_name: &str) -> Option<PathBuf> {
        let suggested = suggested_name.to_string();
        // Deliberately unfiltered: this dialog also saves .mmd and
        // .semantic.json, and a scene filter would fight their extensions —
        // the suggested name already carries the right one.
        self.on_main(move || rfd::FileDialog::new().set_file_name(suggested).save_file())
            .flatten()
    }

    fn confirm(&self, title: &str, message: &str) -> bool {
        let (title, message) = (title.to_string(), message.to_string());
        self.on_main(move || {
            matches!(
                rfd::MessageDialog::new()
                    // A question about something irreversible, which is what
                    // every one of the page's confirmations is about.
                    .set_level(rfd::MessageLevel::Warning)
                    .set_title(title)
                    .set_description(message)
                    // OK/Cancel rather than Yes/No: it is the pair
                    // `window.confirm` raises on the web, so the messages —
                    // written for that box, and unchanged — still read
                    // correctly here, and it is the one two-button shape rfd
                    // renders natively on all three platforms (custom labels
                    // need the `common-controls-v6` feature this build does
                    // not enable; see the updater below).
                    .set_buttons(rfd::MessageButtons::OkCancel)
                    .show(),
                rfd::MessageDialogResult::Ok
            )
        })
        // A box that could not be raised is a "no". The user was never asked,
        // and a destructive action must never proceed on an answer nobody gave.
        .unwrap_or(false)
    }

    fn alert(&self, title: &str, message: &str) {
        let (title, message) = (title.to_string(), message.to_string());
        // The answer is discarded because there is only one button; what
        // matters is that this blocks until the user dismisses it, so a caller
        // showing two messages shows them in order.
        self.on_main(move || {
            rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Info)
                .set_title(title)
                .set_description(message)
                .set_buttons(rfd::MessageButtons::Ok)
                .show();
        });
    }
}

/// The update check's message box, on the same main-thread hop as the file
/// dialogs above and for the same reason.
impl updates::MessageDialog for NativeDialog {
    fn show(&self, outcome: &updates::Outcome) -> bool {
        // Everything the box needs, resolved before it crosses threads.
        let title = outcome.title().to_string();
        let message = outcome.message();
        let affirmative = outcome.affirmative().map(str::to_string);
        self.on_main(move || {
            let dialog = rfd::MessageDialog::new()
                .set_level(rfd::MessageLevel::Info)
                .set_title(title)
                .set_description(message);
            let dialog = match &affirmative {
                Some(label) => dialog.set_buttons(rfd::MessageButtons::OkCancelCustom(
                    label.clone(),
                    updates::LATER_LABEL.to_string(),
                )),
                None => dialog.set_buttons(rfd::MessageButtons::Ok),
            };
            match dialog.show() {
                rfd::MessageDialogResult::Custom(label) => Some(label) == affirmative,
                // Windows renders custom button labels only with rfd's
                // `common-controls-v6` feature, which this build does not
                // enable; without it the two-button box degrades to a plain
                // OK/Cancel one and OK is the affirmative. Guarded on the
                // affirmative so outcomes whose single OK button only
                // dismisses them never act.
                rfd::MessageDialogResult::Ok => affirmative.is_some(),
                _ => false,
            }
        })
        .unwrap_or(false)
    }
}

/// Every id Docent puts in the menu bar, derived from the one list above so the
/// menu and the event guard cannot drift apart.
const MENU_IDS: [&str; MenuAction::ALL.len()] = {
    let mut ids = [""; MenuAction::ALL.len()];
    let mut i = 0;
    while i < ids.len() {
        ids[i] = MenuAction::ALL[i].id();
        i += 1;
    }
    ids
};

/// The ids the shell answers by itself. The update check is entirely Rust —
/// there is no page-side handler to dispatch to and none should be invented,
/// so this id is kept out of `window.__docentMenu`'s union on purpose.
const RUST_ONLY_IDS: [&str; 2] = [
    MenuAction::CheckUpdates.id(),
    MenuAction::AgentEndpoint.id(),
];

/// Whether a menu click is Docent's at all. Predefined items (clipboard,
/// window, quit) carry ids of their own and are the system's business.
fn is_docent_menu_id(id: &str) -> bool {
    MENU_IDS.contains(&id)
}

fn is_rust_only_menu_id(id: &str) -> bool {
    RUST_ONLY_IDS.contains(&id)
}

/// Whether a click is one the page handles: Docent's own ids, minus the ones
/// the shell answers without ever reaching the webview.
fn is_frontend_menu_id(id: &str) -> bool {
    is_docent_menu_id(id) && !is_rust_only_menu_id(id)
}

fn item(app: &AppHandle, action: MenuAction) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, action.id(), action.label(), true, action.accelerator())
}

/// Help → Agent Endpoint… — the one place the shell states its MCP URL (S15),
/// with a line any client's user can paste.
fn show_agent_endpoint(app: AppHandle) {
    let message = match app.try_state::<mcp::McpHandle>() {
        Some(endpoint) => {
            let exe = std::env::current_exe()
                .ok()
                .and_then(|path| path.to_str().map(String::from))
                .unwrap_or_else(|| "<path to the Docent binary>".to_string());
            format!(
                "Any MCP client can drive this Docent — read-only: it can look, \
                 move the camera, and present, never edit.\n\n\
                 Endpoint (streamable HTTP, this machine only):\n{base}/mcp\n\n\
                 Claude Code:\nclaude mcp add --transport http docent {base}/mcp\n\n\
                 Claude Desktop and other stdio-only clients \
                 (claude_desktop_config.json → mcpServers):\n\
                 \"docent\": {{ \"command\": \"{exe}\", \"args\": [\"--agent-stdio\"] }}",
                base = endpoint.base_url(),
            )
        }
        None => "The agent endpoint could not start — see the app's log output.".to_string(),
    };
    let _ = app.run_on_main_thread(move || {
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Info)
            .set_title("Docent")
            .set_description(message)
            .show();
    });
}

/// The one stateful item: a checkbox mirroring whether the page draws
/// detail-layer markers (D31). The menu toggles its own checkmark on click
/// and the page state is session-scoped defaulting to on, so the two start
/// aligned and only this item ever moves either — no page→shell channel
/// needed (the shell deliberately has none).
fn check_item(
    app: &AppHandle,
    action: MenuAction,
    checked: bool,
) -> tauri::Result<CheckMenuItem<Wry>> {
    CheckMenuItem::with_id(
        app,
        action.id(),
        action.label(),
        true,
        checked,
        action.accelerator(),
    )
}

/// The whole menu bar, replacing Tauri's default (D109). Docent's own three
/// submenus are File, Diagram and Project — the app's commands, where a
/// desktop app's commands belong, and every one of them dispatching into the
/// page's one command table (B4) rather than into a copy of it.
///
/// Edit is load-bearing rather than decorative: the system webview takes its
/// clipboard commands from the menu, so without those items Cmd/Ctrl+C, +X and
/// +V do nothing in text inputs. Fullscreen, Services and Hide are macOS-only
/// in the menu backend — elsewhere they would render as entries that do
/// nothing. Every platform gets the same bar; only where it is drawn differs,
/// which is the windowing system's business and not Docent's.
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

    // The exports join File rather than standing as a menu of their own
    // (D109): they are ways of writing the document out, which is what a File
    // menu is for. The PDF is the one export missing here — it is bytes
    // (D105) and the shell's file channel writes text, so the page offers it
    // where a browser download works and nowhere it would fail.
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(app, MenuAction::New)?,
            &item(app, MenuAction::Open)?,
            &item(app, MenuAction::Import)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, MenuAction::Save)?,
            &item(app, MenuAction::SaveAs)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, MenuAction::ExportFile)?,
            &item(app, MenuAction::ExportMermaid)?,
            &item(app, MenuAction::ExportSidecar)?,
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

    // What is done to the drawing, and what is done with it.
    let diagram = Submenu::with_items(
        app,
        "Diagram",
        true,
        &[
            &item(app, MenuAction::Present)?,
            &item(app, MenuAction::Library)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, MenuAction::Tidy)?,
            &item(app, MenuAction::Arrange)?,
            &item(app, MenuAction::Legend)?,
            &check_item(app, MenuAction::DetailMarkers, true)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    // The portfolio and what plugs into it — the app's world outside this one
    // drawing (S12, S15, S17).
    let project = Submenu::with_items(
        app,
        "Project",
        true,
        &[
            &item(app, MenuAction::Portfolio)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, MenuAction::ConnectAgent)?,
            &item(app, MenuAction::Plugins)?,
            &check_item(app, MenuAction::AgentEdit, true)?,
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

    // Help exists on every platform now, because the update check lives here.
    // What differs is About: macOS keeps it in the application menu, so on
    // macOS this submenu holds the one item and nothing else.
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &about,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::separator(app)?,
            &item(app, MenuAction::CheckUpdates)?,
            &item(app, MenuAction::AgentEndpoint)?,
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
            &diagram,
            &project,
            &window,
            // Last on every platform, which is where both conventions put it.
            &help,
        ],
    )
}

/// Run a check on a thread of its own. Every step of it is something the UI
/// thread must not block on: a network round trip, a file write, and finally a
/// dialog that hops back to the main thread and stays there until the user
/// answers it.
/// Whether the canvas holds unsaved work, as the page already tells the
/// window: its title carries a leading "●" while dirty. The one signal the
/// shell needs from the page, and one it already had (D68).
fn canvas_is_dirty(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.title().ok())
        .is_some_and(|t| t.trim_start().starts_with('●'))
}

fn set_title_suffix(app: &AppHandle, suffix: Option<&str>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(title) = window.title() {
            let base = title
                .split(" — updating")
                .next()
                .unwrap_or(&title)
                .to_string();
            let _ = window.set_title(&match suffix {
                Some(s) => format!("{base} — updating: {s}"),
                None => base,
            });
        }
    }
}

/// The whole update flow (D67, D68): once-a-day gate for start-up, the signed
/// manifest first and the release API as the fallback, the announcement, and
/// — on *Install and Relaunch* — download, verify, install, relaunch.
fn spawn_update_check(app: AppHandle, trigger: updates::Trigger) {
    use tauri_plugin_updater::UpdaterExt;
    let Ok(state_dir) = app.path().app_data_dir() else {
        eprintln!("docent: no app-data directory — skipping the update check");
        return;
    };
    let current = app.package_info().version.to_string();
    let endpoint = updates::endpoint();
    // The same variable the store's file dialogs answer to: a run with no
    // display records what would have been shown instead of raising it.
    let dialogs: Box<dyn updates::MessageDialog> = match updates::RecordingDialog::from_env() {
        Some(stub) => Box::new(stub),
        None => Box::new(NativeDialog { app: app.clone() }),
    };
    tauri::async_runtime::spawn(async move {
        if !updates::due(&state_dir, trigger) {
            return;
        }
        // The signed manifest, through the updater; the API when the
        // manifest cannot be read (a release before signing, or a test
        // pointing at its own server).
        let mut update = None;
        let found = match app.updater_builder().build() {
            Ok(updater) if std::env::var("DOCENT_UPDATE_URL").is_err() => {
                match updater.check().await {
                    Ok(Some(found)) => {
                        let version = found.version.clone();
                        update = Some(found);
                        Ok(updates::Found {
                            version,
                            url: "https://github.com/happyren/Docent/releases/latest".to_string(),
                            installable: true,
                        })
                    }
                    Ok(None) => Ok(updates::Found {
                        version: current.clone(),
                        url: "https://github.com/happyren/Docent/releases/latest".to_string(),
                        installable: true,
                    }),
                    Err(err) => {
                        eprintln!(
                            "docent: updater manifest unavailable ({err}); asking the release API"
                        );
                        updates::probe_github(&endpoint)
                    }
                }
            }
            _ => updates::probe_github(&endpoint),
        };
        let Some(outcome) = updates::decide(found, &current, &state_dir, trigger) else {
            return;
        };
        if !dialogs.show(&outcome) {
            return;
        }
        // The affirmative: install when the app can, else open the page.
        let Some(update) = update.filter(|_| outcome.offers_install()) else {
            if let Some(url) = outcome.download_url() {
                updates::open_release_page(url);
            }
            return;
        };
        let version = update.version.clone();
        set_title_suffix(&app, Some("downloading"));
        let mut received: u64 = 0;
        let installed = update
            .download_and_install(
                |chunk, total| {
                    received += chunk as u64;
                    if let Some(total) = total {
                        let pct = (received * 100 / total.max(1)).min(100);
                        set_title_suffix(&app, Some(&format!("{pct}%")));
                    }
                },
                || {},
            )
            .await;
        set_title_suffix(&app, None);
        match installed {
            Ok(()) => {
                let dirty = canvas_is_dirty(&app);
                dialogs.show(&updates::Outcome::Installed {
                    version: version.clone(),
                    dirty,
                });
                if !dirty {
                    app.restart();
                }
            }
            Err(err) => {
                let outcome = updates::Outcome::InstallFailed {
                    version,
                    error: err.to_string(),
                    url: "https://github.com/happyren/Docent/releases/latest".to_string(),
                };
                if dialogs.show(&outcome) {
                    if let Some(url) = outcome.download_url() {
                        updates::open_release_page(url);
                    }
                }
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if is_rust_only_menu_id(id) {
                // Answered here and nowhere else: these have no frontend
                // half, so the click never becomes a `__docentMenu` call.
                if id == MenuAction::CheckUpdates.id() {
                    // A menu-initiated check always shows its result.
                    spawn_update_check(app.clone(), updates::Trigger::Menu);
                } else if id == MenuAction::AgentEndpoint.id() {
                    show_agent_endpoint(app.clone());
                }
                return;
            }
            if !is_frontend_menu_id(id) {
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

            // GitHub tokens (S14) go to the app's *config* directory instead —
            // a different tree from the portfolio on every platform, so D27's
            // "no secrets in the data tree" holds even when a user copies,
            // syncs, or backs up their whole portfolio.
            let secrets_file = handle.path().app_config_dir()?.join("github-tokens.json");

            // The stub exists for environments with no display at all; a real
            // run always gets the platform dialogs.
            let dialogs: Arc<dyn store::Dialogs> = match store::StubDialog::from_env() {
                Some(stub) => Arc::new(stub),
                None => Arc::new(NativeDialog {
                    app: handle.clone(),
                }),
            };

            let api_base = match store::spawn(data_dir, secrets_file, dialogs) {
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

            // The agent endpoint (S15): a loopback pipe any MCP client can
            // POST JSON-RPC to; the page runs the dispatcher. Failing to bind
            // degrades exactly like the store — the canvas is unaffected.
            let mcp_base = match mcp::spawn() {
                Ok(endpoint) => {
                    let base = endpoint.base_url();
                    // The `--agent-stdio` shim finds the live port here even
                    // when the fixed one was taken (D38).
                    mcp::record_port(endpoint.port());
                    // Held for the process lifetime; dropping it stops it.
                    handle.manage(endpoint);
                    Some(base)
                }
                Err(err) => {
                    eprintln!("docent: agent endpoint unavailable — {err}");
                    None
                }
            };

            // Plugins (S17, D50): the provider host lives beside the tokens,
            // in the config directory — a plugin is the person's installation,
            // not portfolio data. Failing to bind degrades like the rest.
            let plugins_base = match handle.path().app_config_dir() {
                Ok(config_dir) => match plugins::spawn(plugins::Host::new(config_dir)) {
                    Ok(endpoint) => {
                        let base = endpoint.base_url();
                        let dir = endpoint.host().dir().to_string_lossy().into_owned();
                        handle.manage(endpoint);
                        Some((base, dir))
                    }
                    Err(err) => {
                        eprintln!("docent: plugins unavailable — {err}");
                        None
                    }
                },
                Err(err) => {
                    eprintln!("docent: plugins unavailable — {err}");
                    None
                }
            };

            // These facts have to be in place before the SPA's first script
            // runs: the flag decides what chrome the app renders, and the base
            // URLs are read at module load. Absent — i.e. on the web — the app
            // is the web app, unchanged.
            let mut script = String::from("window.__DOCENT_DESKTOP__ = true;");
            if let Some(base) = api_base {
                script.push_str(&format!(
                    "window.__DOCENT_API_BASE__ = {};",
                    serde_json::to_string(&base)?
                ));
            }
            if let Some(base) = mcp_base {
                script.push_str(&format!(
                    "window.__DOCENT_MCP_BASE__ = {};",
                    serde_json::to_string(&base)?
                ));
            }
            if let Some((base, dir)) = plugins_base {
                script.push_str(&format!(
                    "window.__DOCENT_PLUGINS_BASE__ = {};window.__DOCENT_PLUGINS_DIR__ = {};window.__DOCENT_CAPABILITIES__ = [\"plugins\"];",
                    serde_json::to_string(&base)?,
                    serde_json::to_string(&dir)?
                ));
            }

            let builder =
                WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                    .title("Docent")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(960.0, 640.0)
                    .initialization_script(script.as_str());
            // The window is borderless (D108): on macOS the title bar becomes an
            // overlay, so the canvas paints to the window's edge and the traffic
            // lights float over it — the title itself hidden, because the paper
            // is the app and the file name is already in the chrome. The page
            // keeps its top-left islands clear of the lights (see the safe-area
            // inset in styles.css) and gives the window a drag strip to move by.
            //
            // Windows and Linux keep their native frames: a custom frame there
            // buys sameness at the cost of every windowing convention.
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            builder.build()?;

            // With the store up and the window built, ask GitHub whether there
            // is a newer release — on a background thread, at most once a day,
            // and silently unless there is one this install has not been told
            // about. It only ever tells: S13 keeps auto-update out of v1, so
            // nothing here installs anything. Raised after the window so a
            // notification has the app behind it rather than an empty desktop.
            spawn_update_check(handle.clone(), updates::Trigger::Startup);
            // …and again every day the app stays open (D68): a laptop that
            // is never quit still hears about a release.
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(24 * 60 * 60));
                spawn_update_check(handle.clone(), updates::Trigger::Startup);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("docent: failed to start the desktop shell")
        .run(|app, event| {
            // The shell exits without unwinding its managed state, so what
            // plugins started is stopped here, on the way out (D50). A kill
            // that never reaches this is swept at the next launch.
            if let RunEvent::Exit = event {
                if let Some(plugins) = app.try_state::<plugins::PluginsHandle>() {
                    plugins.host().stop_all();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        is_docent_menu_id, is_frontend_menu_id, is_rust_only_menu_id, MenuAction, MENU_IDS,
        RUST_ONLY_IDS,
    };

    /// The ids `window.__docentMenu` dispatches on (src/shell/App.tsx),
    /// written out literally in the same order as the union there. A rename on
    /// either side should fail here rather than silently turn a menu item into
    /// a no-op.
    const FRONTEND_IDS: [&str; 18] = [
        "new",
        "open",
        "import",
        "save",
        "save-as",
        "export-file",
        "export-mermaid",
        "export-sidecar",
        "present",
        "library",
        "legend",
        "arrange",
        "tidy",
        "detail-markers",
        "portfolio",
        "connect-agent",
        "plugins",
        "agent-edit",
    ];

    #[test]
    fn menu_ids_match_the_frontend_contract() {
        // The page's half of the contract is every menu id *except* the ones
        // the shell answers itself; those have no handler over there by
        // design, so holding the page to them would be asking for a stub.
        let dispatched: Vec<&str> = MENU_IDS
            .into_iter()
            .filter(|id| is_frontend_menu_id(id))
            .collect();
        assert_eq!(dispatched, FRONTEND_IDS);
    }

    #[test]
    fn every_menu_item_is_answered_by_exactly_one_side() {
        for action in MenuAction::ALL {
            let id = action.id();
            assert!(
                is_docent_menu_id(id),
                "{action:?} would click into the void"
            );
            // Rust-only or page-bound, never both and never neither: an item
            // that is both would be handled twice, and one that is neither is
            // a menu entry that does nothing.
            assert_ne!(
                is_rust_only_menu_id(id),
                is_frontend_menu_id(id),
                "{action:?} must be answered by exactly one side"
            );
        }
    }

    #[test]
    fn the_update_check_never_reaches_the_page() {
        let ids = [
            MenuAction::CheckUpdates.id(),
            MenuAction::AgentEndpoint.id(),
        ];
        assert_eq!(RUST_ONLY_IDS, ids);
        for id in ids {
            assert!(is_docent_menu_id(id), "it is still Docent's own item");
            assert!(is_rust_only_menu_id(id));
            assert!(!is_frontend_menu_id(id), "it has no `__docentMenu` handler");
            assert!(
                !FRONTEND_IDS.contains(&id),
                "adding it to the page's union would invent a handler that should not exist"
            );
        }
    }

    /// D109: the three submenus Docent contributes are File, Diagram and
    /// Project, and every item in them is one the page answers.
    #[test]
    fn the_bar_carries_the_commands_the_amendment_names() {
        for id in [
            // File
            "open", "save", "save-as", "export-mermaid", "export-sidecar",
            // Diagram
            "present", "tidy", "arrange", "legend", "detail-markers",
            // Project
            "portfolio", "connect-agent", "plugins",
        ] {
            assert!(is_frontend_menu_id(id), "{id} is not in the bar");
        }
    }

    #[test]
    fn tidy_is_a_page_item_on_the_format_document_chord() {
        // D73: ⌥⇧F everywhere an editor has it, answered by the page like
        // any other Diagram item — the menu is only the way in.
        assert_eq!(MenuAction::Tidy.id(), "tidy");
        assert_eq!(MenuAction::Tidy.label(), "Tidy Diagram");
        assert_eq!(MenuAction::Tidy.accelerator(), Some("Alt+Shift+F"));
        assert!(is_frontend_menu_id(MenuAction::Tidy.id()));
        assert!(FRONTEND_IDS.contains(&MenuAction::Tidy.id()));
    }

    #[test]
    fn predefined_menu_ids_are_left_alone() {
        // Predefined items get numeric ids from the menu backend.
        assert!(!is_docent_menu_id("1000"));
        assert!(!is_docent_menu_id(""));
        assert!(!is_frontend_menu_id("1000"));
        assert!(!is_rust_only_menu_id("1000"));
    }

    #[test]
    fn menu_ids_are_unique() {
        for (i, id) in MENU_IDS.iter().enumerate() {
            assert!(!MENU_IDS[..i].contains(id), "duplicate menu id: {id}");
        }
    }

    #[test]
    fn accelerators_are_unique() {
        // Two items on one chord is the failure this whole rework is about:
        // the key would reach whichever the menu backend resolved first.
        let keys: Vec<&str> = MenuAction::ALL
            .iter()
            .filter_map(|action| action.accelerator())
            .collect();
        for (i, key) in keys.iter().enumerate() {
            assert!(!keys[..i].contains(key), "two menu items claim {key}");
        }
    }
}

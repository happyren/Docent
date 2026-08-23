//! Plugins (S17, D50) — the desktop's provider host. A plugin is a folder
//! under the app's config directory holding `docent-plugin.json` and,
//! usually, a command to run: the core starts that command with `{port}`
//! substituted, polls its health path, proxies `/plugins/<name>/…` to it on
//! this listener, and terminates it on quit. A plugin may instead name a
//! `url` for a service the person runs themselves; either way the target
//! must be loopback (D53), so nothing the page sends a plugin can leave the
//! machine.
//!
//! No plugin code ever runs in the page. What a plugin *is* to the page is
//! the list this listener answers at `/plugins` and the routes it proxies;
//! what a plugin *does* is fixed by the contracts it declares (D51) — the
//! core refuses a contract major it does not know.
//!
//! A pool of workers serves the socket, like the MCP pipe: a proxied reply
//! streams for as long as the provider talks (a spoken paragraph is
//! seconds), and the listing must still answer meanwhile. The store's
//! single-worker listener is never involved.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tiny_http::{Header, Method, Response, Server, StatusCode};

use crate::store::ALLOWED_ORIGINS;

/// The contracts this core knows how to consume, by major (D51).
pub const KNOWN_CONTRACTS: &[&str] = &["speech/1"];

const MANIFEST_FILE: &str = "docent-plugin.json";
const SETTINGS_FILE: &str = "plugins.json";
/// The pids of what this host started, so a launch after a crash or a kill
/// can stop what the previous one left behind.
const PIDS_FILE: &str = "plugins-pids.json";
const WORKERS: usize = 4;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// How often a starting plugin is asked whether it is up.
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);
/// A provider that answers nothing for this long while its process lives is
/// reported as still starting — a first run may be downloading weights — so
/// there is no hard deadline, only the process exiting.
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// A streamed reply may legitimately run for a while (a long narration);
/// this is the ceiling on a single proxied request.
const PROXY_TOTAL_TIMEOUT: Duration = Duration::from_secs(600);

// ---------------------------------------------------------------------------
// the manifest
// ---------------------------------------------------------------------------

/// How a plugin is started: a command with `{port}` in its arguments.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Run {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// The path polled until it answers; any HTTP status counts as up.
    #[serde(default = "default_health")]
    pub health: String,
}

fn default_health() -> String {
    "/".to_string()
}

/// `docent-plugin.json`, as documented in docs/plugins.md. Unknown fields
/// are kept out of the listing rather than refused, so a manifest written
/// for a later core still loads here.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Manifest {
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// The contracts fulfilled, e.g. `speech/1`.
    #[serde(default)]
    pub contracts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<Run>,
    /// A service the person runs themselves — loopback only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Free-form licensing facts the panel shows verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<serde_json::Value>,
    /// The `speech/1` fallback when the provider has no `/voices`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voices: Option<serde_json::Value>,
    /// A link the panel offers — the plugin's home.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
}

/// `^[a-z0-9][a-z0-9-]{0,63}$` — a name is also a path segment and a route.
pub fn valid_plugin_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// Why a manifest cannot be used, in one line the panel shows.
fn refusal(manifest: &Manifest, folder: &str) -> Option<String> {
    if manifest.name != folder {
        return Some(format!(
            "manifest name '{}' does not match its folder '{folder}'",
            manifest.name
        ));
    }
    if !valid_plugin_name(&manifest.name) {
        return Some("invalid name — lowercase letters, digits and - (max 64)".to_string());
    }
    if manifest.contracts.is_empty() {
        return Some("no contracts declared".to_string());
    }
    for contract in &manifest.contracts {
        if !KNOWN_CONTRACTS.contains(&contract.as_str()) {
            return Some(format!(
                "contract '{contract}' is not one this Docent knows ({})",
                KNOWN_CONTRACTS.join(", ")
            ));
        }
    }
    match (&manifest.run, &manifest.url) {
        (None, None) => return Some("neither run nor url declared".to_string()),
        (Some(_), Some(_)) => return Some("declare run or url, not both".to_string()),
        (Some(run), None) => {
            if run.command.trim().is_empty() {
                return Some("run.command is empty".to_string());
            }
            if !run.args.iter().any(|a| a.contains("{port}")) {
                return Some("run.args must carry {port} somewhere".to_string());
            }
            if !run.health.starts_with('/') {
                return Some("run.health must be a path starting with /".to_string());
            }
        }
        (None, Some(url)) => {
            if !is_loopback(url) {
                return Some(format!(
                    "url must be loopback (http://127.0.0.1 or localhost), not {url}"
                ));
            }
        }
    }
    None
}

/// D53: the only hosts a plugin may answer from.
pub fn is_loopback(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let host_port = rest.split('/').next().unwrap_or_default();
    let host = host_port.rsplit_once(':').map_or(host_port, |(h, _)| h);
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "detail")]
pub enum Status {
    /// Loaded and usable, not enabled.
    Stopped,
    /// Enabled; the process is up but its health path has not answered yet.
    Starting,
    /// Enabled and answering.
    Running,
    /// Enabled, but the process is gone or could not start.
    Failed(String),
    /// The manifest cannot be used; the reason is the payload.
    Refused(String),
}

struct Plugin {
    manifest: Manifest,
    dir: PathBuf,
    status: Status,
    /// Where requests go once running.
    base: Option<String>,
    child: Option<Child>,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Settings {
    #[serde(default)]
    enabled: Vec<String>,
}

/// What the listing answers for one plugin.
#[derive(serde::Serialize)]
pub struct Listed {
    pub name: String,
    pub version: String,
    pub description: String,
    pub contracts: Vec<String>,
    pub enabled: bool,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voices: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// The path the page talks to, relative to the plugins base.
    pub route: String,
    /// Where the process writes what it says, for the person to read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log: Option<String>,
}

pub struct Host {
    /// `<config>/plugins/`
    dir: PathBuf,
    settings_file: PathBuf,
    pids_file: PathBuf,
    plugins: Mutex<BTreeMap<String, Plugin>>,
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Pids {
    #[serde(default)]
    started: BTreeMap<String, u32>,
}

impl Host {
    pub fn new(config_dir: PathBuf) -> Arc<Self> {
        let host = Arc::new(Self {
            dir: config_dir.join("plugins"),
            settings_file: config_dir.join(SETTINGS_FILE),
            pids_file: config_dir.join(PIDS_FILE),
            plugins: Mutex::new(BTreeMap::new()),
        });
        host.sweep_stale();
        host.rescan();
        host
    }

    /// Stop whatever a previous host recorded and never got to stop — the
    /// app was killed, or crashed, with an engine running.
    fn sweep_stale(&self) {
        let stale: Pids = fs::read_to_string(&self.pids_file)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        for pid in stale.started.values() {
            if *pid == std::process::id() {
                continue;
            }
            kill_tree(*pid);
        }
        let _ = fs::remove_file(&self.pids_file);
    }

    fn record_pid(&self, name: &str, pid: Option<u32>) {
        let mut pids: Pids = fs::read_to_string(&self.pids_file)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        match pid {
            Some(pid) => {
                pids.started.insert(name.to_string(), pid);
            }
            None => {
                pids.started.remove(name);
            }
        }
        if let Some(parent) = self.pids_file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&pids) {
            let _ = fs::write(&self.pids_file, json + "\n");
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn settings(&self) -> Settings {
        fs::read_to_string(&self.settings_file)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save_settings(&self, settings: &Settings) {
        if let Some(parent) = self.settings_file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(settings) {
            let _ = fs::write(&self.settings_file, json + "\n");
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Plugin>> {
        self.plugins.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Re-read every manifest. Running plugins keep running; a plugin whose
    /// folder vanished is stopped and dropped.
    pub fn rescan(&self) {
        let _ = fs::create_dir_all(&self.dir);
        let mut found: BTreeMap<String, (Manifest, PathBuf, Option<String>)> = BTreeMap::new();
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let folder = entry.file_name().to_string_lossy().into_owned();
                let Ok(raw) = fs::read_to_string(path.join(MANIFEST_FILE)) else {
                    continue;
                };
                match serde_json::from_str::<Manifest>(&raw) {
                    Ok(manifest) => {
                        let why = refusal(&manifest, &folder);
                        found.insert(folder, (manifest, path, why));
                    }
                    Err(err) => {
                        let manifest = Manifest {
                            name: folder.clone(),
                            version: String::new(),
                            description: String::new(),
                            contracts: Vec::new(),
                            run: None,
                            url: None,
                            license: None,
                            voices: None,
                            homepage: None,
                        };
                        found.insert(
                            folder,
                            (
                                manifest,
                                path,
                                Some(format!("manifest is not valid JSON — {err}")),
                            ),
                        );
                    }
                }
            }
        }
        let mut plugins = self.lock();
        let gone: Vec<String> = plugins
            .keys()
            .filter(|k| !found.contains_key(*k))
            .cloned()
            .collect();
        for name in gone {
            if let Some(mut plugin) = plugins.remove(&name) {
                stop_process(&mut plugin);
            }
        }
        for (name, (manifest, dir, why)) in found {
            match plugins.get_mut(&name) {
                Some(existing) => {
                    existing.manifest = manifest;
                    existing.dir = dir;
                    if let Some(why) = why {
                        stop_process(existing);
                        existing.status = Status::Refused(why);
                        existing.base = None;
                    } else if matches!(existing.status, Status::Refused(_)) {
                        existing.status = Status::Stopped;
                    }
                }
                None => {
                    plugins.insert(
                        name,
                        Plugin {
                            manifest,
                            dir,
                            status: match why {
                                Some(why) => Status::Refused(why),
                                None => Status::Stopped,
                            },
                            base: None,
                            child: None,
                        },
                    );
                }
            }
        }
    }

    /// Start everything the person enabled last time. Called once at launch.
    pub fn start_enabled(self: &Arc<Self>) {
        for name in self.settings().enabled {
            let _ = self.enable(&name, false);
        }
    }

    pub fn list(&self) -> Vec<Listed> {
        let enabled = self.settings().enabled;
        self.lock()
            .values()
            .map(|plugin| Listed {
                name: plugin.manifest.name.clone(),
                version: plugin.manifest.version.clone(),
                description: plugin.manifest.description.clone(),
                contracts: plugin.manifest.contracts.clone(),
                enabled: enabled.contains(&plugin.manifest.name),
                status: plugin.status.clone(),
                license: plugin.manifest.license.clone(),
                voices: plugin.manifest.voices.clone(),
                homepage: plugin.manifest.homepage.clone(),
                route: format!("/plugins/{}", plugin.manifest.name),
                log: plugin
                    .manifest
                    .run
                    .as_ref()
                    .map(|_| log_file(&plugin.dir).to_string_lossy().into_owned()),
            })
            .collect()
    }

    /// Enable: remember it (when asked) and start it. Answers the reason when
    /// it cannot.
    pub fn enable(self: &Arc<Self>, name: &str, remember: bool) -> Result<(), String> {
        let (manifest, dir) = {
            let plugins = self.lock();
            let plugin = plugins
                .get(name)
                .ok_or_else(|| format!("no plugin named {name}"))?;
            if let Status::Refused(why) = &plugin.status {
                return Err(why.clone());
            }
            if matches!(plugin.status, Status::Running | Status::Starting) {
                if remember {
                    self.remember(name, true);
                }
                return Ok(());
            }
            (plugin.manifest.clone(), plugin.dir.clone())
        };
        if remember {
            self.remember(name, true);
        }
        if let Some(url) = &manifest.url {
            let base = url.trim_end_matches('/').to_string();
            {
                let mut plugins = self.lock();
                if let Some(plugin) = plugins.get_mut(name) {
                    plugin.base = Some(base.clone());
                    plugin.status = Status::Starting;
                }
            }
            self.watch(name.to_string(), base, "/".to_string(), None);
            return Ok(());
        }
        let run = manifest.run.clone().ok_or("nothing to run")?;
        let port = free_port().map_err(|e| format!("no free port — {e}"))?;
        let args: Vec<String> = run
            .args
            .iter()
            .map(|a| a.replace("{port}", &port.to_string()))
            .collect();
        // Truncated at each start, appended to by every writer — so a
        // previous engine's last words, written through the handle it still
        // holds, land at the end instead of past a hole.
        let path = log_file(&dir);
        let _ = fs::write(&path, "");
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("cannot open log — {e}"))?;
        let err_log = log
            .try_clone()
            .map_err(|e| format!("cannot open log — {e}"))?;
        let mut command = provider_command(&run.command, &args);
        command
            .current_dir(&dir)
            .env("PATH", provider_path())
            .env("DOCENT_PLUGIN_PORT", port.to_string())
            .env("DOCENT_HOST_PID", std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err_log));
        let child = command
            .spawn()
            .map_err(|e| format!("cannot start '{}' — {e}", run.command))?;
        self.record_pid(name, Some(child.id()));
        let base = format!("http://127.0.0.1:{port}");
        {
            let mut plugins = self.lock();
            if let Some(plugin) = plugins.get_mut(name) {
                plugin.child = Some(child);
                plugin.base = Some(base.clone());
                plugin.status = Status::Starting;
            }
        }
        self.watch(name.to_string(), base, run.health, Some(()));
        Ok(())
    }

    /// Disable: stop it and forget it.
    pub fn disable(&self, name: &str) -> Result<(), String> {
        self.remember(name, false);
        let mut plugins = self.lock();
        let plugin = plugins
            .get_mut(name)
            .ok_or_else(|| format!("no plugin named {name}"))?;
        if matches!(plugin.status, Status::Refused(_)) {
            return Ok(());
        }
        stop_process(plugin);
        self.record_pid(name, None);
        plugin.status = Status::Stopped;
        plugin.base = None;
        Ok(())
    }

    fn remember(&self, name: &str, on: bool) {
        let mut settings = self.settings();
        settings.enabled.retain(|n| n != name);
        if on {
            settings.enabled.push(name.to_string());
        }
        self.save_settings(&settings);
    }

    /// Poll the health path until it answers or the process dies.
    fn watch(self: &Arc<Self>, name: String, base: String, health: String, owned: Option<()>) {
        let host = Arc::clone(self);
        thread::spawn(move || {
            let agent: ureq::Agent = ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(3)))
                .http_status_as_error(false)
                .build()
                .into();
            let started = Instant::now();
            loop {
                thread::sleep(HEALTH_INTERVAL);
                // Still the plugin we started? Disabled or replaced means stop.
                let alive = {
                    let mut plugins = host.lock();
                    let Some(plugin) = plugins.get_mut(&name) else {
                        return;
                    };
                    if plugin.base.as_deref() != Some(base.as_str()) {
                        return;
                    }
                    if owned.is_some() {
                        match plugin.child.as_mut().map(|c| c.try_wait()) {
                            Some(Ok(Some(exit))) => {
                                let said = last_words(&plugin.dir)
                                    .map(|w| format!(" — {w}"))
                                    .unwrap_or_else(|| " — see its log".to_string());
                                plugin.status = Status::Failed(format!(
                                    "process exited ({exit}) after {}s{said}",
                                    started.elapsed().as_secs()
                                ));
                                plugin.child = None;
                                return;
                            }
                            Some(Ok(None)) => true,
                            Some(Err(err)) => {
                                plugin.status =
                                    Status::Failed(format!("cannot watch process — {err}"));
                                return;
                            }
                            None => return,
                        }
                    } else {
                        true
                    }
                };
                if !alive {
                    return;
                }
                let up = agent.get(format!("{base}{health}")).call().is_ok();
                if up {
                    let mut plugins = host.lock();
                    if let Some(plugin) = plugins.get_mut(&name) {
                        if plugin.base.as_deref() == Some(base.as_str()) {
                            plugin.status = Status::Running;
                        }
                    }
                    return;
                }
                if owned.is_none() && started.elapsed() > Duration::from_secs(30) {
                    // An attached service that never answers is the person's
                    // to fix; say so rather than poll forever.
                    let mut plugins = host.lock();
                    if let Some(plugin) = plugins.get_mut(&name) {
                        if plugin.base.as_deref() == Some(base.as_str()) {
                            plugin.status = Status::Failed(format!("{base} did not answer in 30s"));
                        }
                    }
                    return;
                }
            }
        });
    }

    /// Where a running plugin answers, or why it cannot be asked.
    fn base_of(&self, name: &str) -> Result<String, (u16, String)> {
        let plugins = self.lock();
        let plugin = plugins
            .get(name)
            .ok_or_else(|| (404, format!("no plugin named {name}")))?;
        match (&plugin.status, &plugin.base) {
            (Status::Running, Some(base)) => Ok(base.clone()),
            (Status::Starting, _) => Err((503, format!("{name} is still starting"))),
            (Status::Failed(why), _) => Err((503, format!("{name} failed — {why}"))),
            (Status::Refused(why), _) => Err((503, format!("{name} is refused — {why}"))),
            _ => Err((503, format!("{name} is not enabled"))),
        }
    }

    /// Stop everything this process started. Called on quit.
    pub fn stop_all(&self) {
        let mut plugins = self.lock();
        for plugin in plugins.values_mut() {
            stop_process(plugin);
            if !matches!(plugin.status, Status::Refused(_)) {
                plugin.status = Status::Stopped;
                plugin.base = None;
            }
        }
        let _ = fs::remove_file(&self.pids_file);
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.stop_all();
    }
}

fn log_file(dir: &Path) -> PathBuf {
    dir.join("plugin.log")
}

fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

/// The PATH a provider's command is looked up on. A desktop app started
/// from the Dock or relaunched by the updater inherits the bare system
/// PATH, not the person's — `uvx` lives in `~/.local/bin`, Homebrew in
/// `/opt/homebrew/bin`, neither on it — so the login shell's PATH is read
/// once and joined in, with the well-known install folders as a fallback
/// for a shell that could not be asked. Order: the process's own PATH
/// first, then the shell's, then the fallbacks, without repeats.
fn provider_path() -> String {
    static PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let own = std::env::var("PATH").unwrap_or_default();
        let shell = login_shell_path().unwrap_or_default();
        let home = std::env::var("HOME").unwrap_or_default();
        let fallback = [
            format!("{home}/.local/bin"),
            format!("{home}/.cargo/bin"),
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
            "/opt/local/bin".to_string(),
        ];
        merge_paths(&own, &shell, &fallback)
    })
    .clone()
}

fn merge_paths(own: &str, shell: &str, fallback: &[String]) -> String {
    let mut seen = Vec::<String>::new();
    let mut push = |entry: &str| {
        if !entry.is_empty() && !seen.iter().any(|s| s == entry) {
            seen.push(entry.to_string());
        }
    };
    for entry in own.split(PATH_SEPARATOR) {
        push(entry);
    }
    for entry in shell.split(PATH_SEPARATOR) {
        push(entry);
    }
    for entry in fallback {
        push(entry);
    }
    seen.join(PATH_SEPARATOR)
}

#[cfg(unix)]
const PATH_SEPARATOR: &str = ":";
#[cfg(not(unix))]
const PATH_SEPARATOR: &str = ";";

/// What the person's login shell puts on PATH — asked as an interactive
/// login shell, since `~/.zshrc` is where most PATH lines live, with a
/// marker so a banner or a prompt cannot be mistaken for the answer.
/// None when there is no shell, it does not answer within a few seconds,
/// or it prints no marker.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let mut child = Command::new(&shell)
        .args(["-ilc", "printf '\\n__DOCENT_PATH__%s\\n' \"$PATH\""])
        .env("TERM", "dumb")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    let out = reader.join().ok()?;
    out.lines()
        .rev()
        .find_map(|line| line.strip_prefix("__DOCENT_PATH__"))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<String> {
    None
}

/// The last thing a provider said before it died — for the panel, so
/// "exited (127)" reads "uvx: command not found".
fn last_words(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(log_file(dir)).ok()?;
    text.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty() && !l.starts_with("[1]"))
        .map(|l| l.chars().take(160).collect())
}

/// On Unix the provider runs under a watcher: a `sh` that starts the
/// command in its own process group, and ends that whole group when the
/// host process disappears — however it disappeared — or when the watcher
/// itself is told to stop. The shell exits without unwinding its state,
/// and a kill reaches no Rust at all, so the tie to the parent has to be
/// made by the child's side. Elsewhere the command runs directly and the
/// launch sweep covers what a kill leaves behind.
#[cfg(unix)]
const WATCHER: &str = r#"set -m
"$0" "$@" &
child=$!
finish() { kill -TERM -- -"$child" 2>/dev/null; kill -TERM "$child" 2>/dev/null; exit 0; }
trap finish TERM INT HUP
while kill -0 "$DOCENT_HOST_PID" 2>/dev/null && kill -0 "$child" 2>/dev/null; do sleep 1; done
if kill -0 "$child" 2>/dev/null; then finish; fi
wait "$child"
"#;

#[cfg(unix)]
fn provider_command(program: &str, args: &[String]) -> Command {
    let mut command = Command::new("sh");
    command.arg("-c").arg(WATCHER).arg(program).args(args);
    command
}

#[cfg(not(unix))]
fn provider_command(program: &str, args: &[String]) -> Command {
    let mut command = Command::new(program);
    command.args(args);
    command
}

/// Terminate what was started: ask the watcher to finish its group, give
/// it a moment, then make sure.
fn stop_process(plugin: &mut Plugin) {
    if let Some(mut child) = plugin.child.take() {
        let pid = child.id();
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(3) {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        kill_children(pid);
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(unix)]
fn kill_children(pid: u32) {
    let _ = Command::new("pkill")
        .args(["-TERM", "-P", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(unix))]
fn kill_children(_pid: u32) {}

/// A process this host did not spawn — a previous run's — by pid: its
/// children, then itself.
fn kill_tree(pid: u32) {
    kill_children(pid);
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

// ---------------------------------------------------------------------------
// the listener
// ---------------------------------------------------------------------------

/// The running plugins endpoint. Dropping it stops the listener, joins the
/// pool, and stops every plugin process.
pub struct PluginsHandle {
    port: u16,
    server: Arc<Server>,
    workers: Vec<JoinHandle<()>>,
    host: Arc<Host>,
}

impl PluginsHandle {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// What the shell injects as `window.__DOCENT_PLUGINS_BASE__`.
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn host(&self) -> &Arc<Host> {
        &self.host
    }
}

impl Drop for PluginsHandle {
    fn drop(&mut self) {
        for _ in 0..self.workers.len() {
            self.server.unblock();
        }
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
        self.host.stop_all();
    }
}

/// Bind the plugins endpoint on an ephemeral loopback port and start what
/// was enabled last time.
pub fn spawn(host: Arc<Host>) -> std::io::Result<PluginsHandle> {
    let server = Server::http((Ipv4Addr::LOCALHOST, 0))
        .map_err(|err| std::io::Error::other(err.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| std::io::Error::other("plugins endpoint did not bind a TCP port"))?
        .port();
    let server = Arc::new(server);
    let workers = (0..WORKERS)
        .map(|_| {
            let server = Arc::clone(&server);
            let host = Arc::clone(&host);
            thread::spawn(move || {
                while let Ok(request) = server.recv() {
                    serve(&host, request);
                }
            })
        })
        .collect();
    host.start_enabled();
    Ok(PluginsHandle {
        port,
        server,
        workers,
        host,
    })
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn cors(origin: Option<&str>) -> Option<Vec<Header>> {
    let origin = origin?;
    if !ALLOWED_ORIGINS.contains(&origin) {
        return None;
    }
    Some(vec![
        header("Access-Control-Allow-Origin", origin),
        header("Vary", "Origin"),
        header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        header("Access-Control-Allow-Headers", "content-type"),
    ])
}

fn respond_json(request: tiny_http::Request, status: u16, body: String, extra: Vec<Header>) {
    let mut response = Response::from_string(body).with_status_code(status);
    response.add_header(header("Content-Type", "application/json"));
    for h in extra {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

fn serve(host: &Arc<Host>, request: tiny_http::Request) {
    let url = request.url().to_string();
    let method = request.method().clone();
    let origin = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Origin"))
        .map(|h| h.value.as_str().to_string());
    // The page is the only caller: its fetches carry the webview origin,
    // curl carries none. Same belt as the store and the MCP bridge.
    let Some(extra) = cors(origin.as_deref()) else {
        respond_json(request, 403, error_json("forbidden origin"), Vec::new());
        return;
    };
    if method == Method::Options {
        let mut response = Response::empty(204);
        for h in extra {
            response.add_header(h);
        }
        let _ = request.respond(response);
        return;
    }
    let path = url.split('?').next().unwrap_or_default().to_string();
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.first() != Some(&"plugins") {
        respond_json(request, 404, error_json("not found"), extra);
        return;
    }
    match (&method, segments.len()) {
        (Method::Get, 1) => {
            let body = serde_json::to_string(&host.list()).unwrap_or_else(|_| "[]".to_string());
            respond_json(request, 200, body, extra);
        }
        (Method::Post, 2) if segments[1] == "rescan" => {
            host.rescan();
            let body = serde_json::to_string(&host.list()).unwrap_or_else(|_| "[]".to_string());
            respond_json(request, 200, body, extra);
        }
        (Method::Post, 3) if segments[2] == "enable" || segments[2] == "disable" => {
            let name = segments[1];
            let result = if segments[2] == "enable" {
                host.enable(name, true)
            } else {
                host.disable(name)
            };
            match result {
                Ok(()) => {
                    let body =
                        serde_json::to_string(&host.list()).unwrap_or_else(|_| "[]".to_string());
                    respond_json(request, 200, body, extra);
                }
                Err(why) => respond_json(request, 409, error_json(&why), extra),
            }
        }
        (_, n) if n >= 2 => {
            let name = segments[1];
            let rest = format!("/{}", segments[2..].join("/"));
            let query = url
                .split_once('?')
                .map(|(_, q)| format!("?{q}"))
                .unwrap_or_default();
            match host.base_of(name) {
                Ok(base) => proxy(request, &format!("{base}{rest}{query}"), extra),
                Err((status, why)) => respond_json(request, status, error_json(&why), extra),
            }
        }
        _ => respond_json(request, 404, error_json("not found"), extra),
    }
}

/// Forward one request to the provider and stream its answer back as it
/// arrives — chunked, so a spoken paragraph plays from its first bytes.
fn proxy(mut request: tiny_http::Request, target: &str, extra: Vec<Header>) {
    let method = request.method().to_string();
    let content_type = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Content-Type"))
        .map(|h| h.value.as_str().to_string());
    let mut body = Vec::new();
    if request
        .as_reader()
        .take(MAX_BODY_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .is_err()
        || body.len() > MAX_BODY_BYTES
    {
        respond_json(request, 413, error_json("body too large"), extra);
        return;
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(PROXY_CONNECT_TIMEOUT))
        .timeout_global(Some(PROXY_TOTAL_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .into();
    let mut builder = ureq::http::Request::builder()
        .method(method.as_str())
        .uri(target);
    if let Some(ct) = &content_type {
        builder = builder.header("Content-Type", ct.as_str());
    }
    let sent = match builder.body(body) {
        Ok(req) => agent.run(req),
        Err(err) => {
            respond_json(
                request,
                502,
                error_json(&format!("bad proxy request — {err}")),
                extra,
            );
            return;
        }
    };
    let upstream = match sent {
        Ok(upstream) => upstream,
        Err(err) => {
            respond_json(
                request,
                502,
                error_json(&format!("plugin did not answer — {err}")),
                extra,
            );
            return;
        }
    };
    let status = upstream.status().as_u16();
    let mut headers = extra;
    if let Some(ct) = upstream
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
    {
        headers.push(header("Content-Type", ct));
    }
    headers.push(header("Cache-Control", "no-store"));
    let reader = upstream.into_body().into_reader();
    let response = Response::new(StatusCode(status), headers, reader, None, None);
    let _ = request.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_path_segments() {
        assert!(valid_plugin_name("pocket-tts"));
        assert!(valid_plugin_name("a1"));
        assert!(!valid_plugin_name(""));
        assert!(!valid_plugin_name("Pocket"));
        assert!(!valid_plugin_name("-x"));
        assert!(!valid_plugin_name("a/b"));
        assert!(!valid_plugin_name("a b"));
    }

    #[test]
    fn only_loopback_urls_pass() {
        assert!(is_loopback("http://127.0.0.1:8000"));
        assert!(is_loopback("http://localhost:8000/"));
        assert!(is_loopback("http://[::1]:8000"));
        assert!(!is_loopback("https://127.0.0.1:8000"));
        assert!(!is_loopback("http://192.168.1.28:8000"));
        assert!(!is_loopback("http://api.example.com"));
    }

    fn manifest(run: Option<Run>, url: Option<&str>) -> Manifest {
        Manifest {
            name: "demo".into(),
            version: "1.0.0".into(),
            description: String::new(),
            contracts: vec!["speech/1".into()],
            run,
            url: url.map(String::from),
            license: None,
            voices: None,
            homepage: None,
        }
    }

    #[test]
    fn manifests_are_refused_for_the_documented_reasons() {
        let ok = manifest(
            Some(Run {
                command: "x".into(),
                args: vec!["--port".into(), "{port}".into()],
                health: "/".into(),
            }),
            None,
        );
        assert_eq!(refusal(&ok, "demo"), None);
        assert!(refusal(&ok, "other").unwrap().contains("does not match"));
        let mut unknown = ok.clone();
        unknown.contracts = vec!["speech/2".into()];
        assert!(refusal(&unknown, "demo").unwrap().contains("speech/2"));
        let mut none = ok.clone();
        none.contracts.clear();
        assert!(refusal(&none, "demo").unwrap().contains("no contracts"));
        let mut no_port = ok.clone();
        no_port.run.as_mut().unwrap().args = vec!["serve".into()];
        assert!(refusal(&no_port, "demo").unwrap().contains("{port}"));
        let remote = manifest(None, Some("http://10.0.0.2:8000"));
        assert!(refusal(&remote, "demo").unwrap().contains("loopback"));
        let local = manifest(None, Some("http://127.0.0.1:8000"));
        assert_eq!(refusal(&local, "demo"), None);
        let both = manifest(ok.run.clone(), Some("http://127.0.0.1:8000"));
        assert!(refusal(&both, "demo").unwrap().contains("not both"));
    }

    #[test]
    fn provider_path_is_own_then_shell_then_fallback_without_repeats() {
        // Joined with the platform's own separator: a colon on Unix, a
        // semicolon on Windows.
        let own = ["/usr/bin", "/bin"].join(PATH_SEPARATOR);
        let shell = ["/opt/homebrew/bin", "/usr/bin", ""].join(PATH_SEPARATOR);
        let fallback = ["/home/k/.local/bin".to_string(), "/usr/bin".to_string()];
        let merged = merge_paths(&own, &shell, &fallback);
        let parts: Vec<&str> = merged.split(PATH_SEPARATOR).collect();
        assert_eq!(
            parts,
            [
                "/usr/bin",
                "/bin",
                "/opt/homebrew/bin",
                "/home/k/.local/bin"
            ]
        );
        // No shell answer: the fallbacks still make it.
        assert!(merge_paths("/usr/bin", "", &fallback).ends_with("/home/k/.local/bin"));
    }

    #[cfg(unix)]
    #[test]
    fn the_login_shell_answers_with_a_single_line_path() {
        // Whatever the shell on this machine is, the answer is one clean
        // PATH line or nothing — never a banner or a prompt.
        if let Some(path) = login_shell_path() {
            assert!(!path.contains('\n'));
            assert!(path.split(':').any(|p| p == "/usr/bin" || p == "/bin"));
        }
    }

    #[test]
    fn a_failed_providers_last_words_are_read_from_its_log() {
        let dir = std::env::temp_dir().join(format!("docent-last-words-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            log_file(&dir),
            "starting\nuvx: line 1: uvx: command not found\n[1]+  Done(127)   \"$0\" \"$@\"\n",
        )
        .unwrap();
        assert_eq!(
            last_words(&dir).as_deref(),
            Some("uvx: line 1: uvx: command not found")
        );
        fs::write(log_file(&dir), "").unwrap();
        assert_eq!(last_words(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }
}

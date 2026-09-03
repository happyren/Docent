/**
 * The Plugins panel (S17, S18): what is installed in the shell's plugin
 * folder — name, version, contract, license, status — with one switch
 * each, and the voice: the gesture that turns speech on, the voice to use,
 * a mute, and a line to try. Nothing here runs plugin code; it reads the
 * host's listing and toggles providers through it.
 */
import { useCallback, useEffect, useState } from "react";
import {
  disablePlugin,
  enablePlugin,
  listPlugins,
  pluginUrl,
  providerOf,
  rescanPlugins,
  type PluginInfo,
} from "../plugins/client";
import { openPluginPanel } from "./desktop-files";
import type { SpeechController, SpeechState } from "../speech/controller";
import { alertDialog } from "./dialogs";

const SAMPLE_LINE =
  "Requests land at the gateway first; every order is verified before it reaches payments, and 8,000 requests per second is the p99 budget.";

const DOCS_URL = "https://github.com/happyren/Docent/blob/master/docs/plugins.md";
const FIRST_PLUGIN_URL = "https://github.com/happyren/docent-pocket-tts";

function statusOf(plugin: PluginInfo): { label: string; tone: "on" | "wait" | "off" | "bad"; detail?: string } {
  switch (plugin.status.kind) {
    case "running":
      return { label: "running", tone: "on" };
    case "starting":
      return { label: "starting", tone: "wait" };
    case "stopped":
      return { label: plugin.enabled ? "stopped" : "off", tone: "off" };
    case "failed":
      return { label: "failed", tone: "bad", detail: plugin.status.detail };
    case "refused":
      return { label: "refused", tone: "bad", detail: plugin.status.detail };
  }
}

function licenseRows(license: unknown): [string, string][] {
  if (typeof license === "string") return [["license", license]];
  if (license && typeof license === "object") {
    return Object.entries(license as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
  }
  return [];
}

/** The house's toggle — shared with Settings (D115), which flips the same
    kind of switch and must look like it. */
export function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className={"docent-switch" + (disabled ? " is-disabled" : "")} title={label}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className="docent-switch-track">
        <span className="docent-switch-thumb" />
      </span>
    </label>
  );
}

function PluginCard({
  plugin,
  busy,
  onToggle,
}: {
  plugin: PluginInfo;
  busy: boolean;
  onToggle: (plugin: PluginInfo) => void;
}) {
  const status = statusOf(plugin);
  const rows = licenseRows(plugin.license);
  const icon = plugin.contracts.includes("speech/1") ? "🔊" : "🔌";
  return (
    <article className={"docent-plugin-card is-" + status.tone}>
      <header className="docent-plugin-card-head">
        <span className="docent-plugin-icon" aria-hidden>
          {icon}
        </span>
        <div className="docent-plugin-title">
          <strong>{plugin.name}</strong>
          <span className="docent-plugin-chips">
            {plugin.version && <span className="docent-chip">v{plugin.version}</span>}
            {plugin.contracts.map((c) => (
              <span key={c} className="docent-chip is-contract">
                {c}
              </span>
            ))}
            <span className={"docent-status is-" + status.tone}>
              <span className="docent-status-dot" />
              {status.label}
            </span>
          </span>
        </div>
        <Switch
          checked={plugin.enabled}
          disabled={busy || plugin.status.kind === "refused"}
          onChange={() => onToggle(plugin)}
          label={plugin.enabled ? `Switch ${plugin.name} off` : `Switch ${plugin.name} on`}
        />
      </header>
      {plugin.description && <p className="docent-plugin-desc">{plugin.description}</p>}
      {status.detail && <p className="docent-plugin-problem">{status.detail}</p>}
      {rows.length > 0 && (
        <dl className="docent-plugin-license">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {/* The referee's word (D152), before the click. */}
      {plugin.conflicts && plugin.conflicts.length > 0 && (
        <p className="docent-plugin-conflict">
          {plugin.conflicts.map((c) => `${c.with} holds ${c.over}`).join(" · ")} — stop it to enable this one
        </p>
      )}
      <footer className="docent-plugin-links">
        {plugin.homepage && (
          <a href={plugin.homepage} target="_blank" rel="noreferrer">
            ↗ home
          </a>
        )}
        {plugin.panel && plugin.status.kind === "running" && (
          <button
            type="button"
            title={`Open ${plugin.panel.title} in a window beside the canvas`}
            onClick={() => void openPluginPanel(plugin.panel!.title, plugin.panel!.url)}
          >
            Open panel — {plugin.panel.title}
          </button>
        )}
        {plugin.status.kind === "running" && (
          <code title="Where the page reaches this plugin">{pluginUrl(plugin.name, "/")}</code>
        )}
        {plugin.log && (
          <span className="docent-plugin-log" title={plugin.log}>
            log · {plugin.log.replace(/^.*\/plugins\//, "plugins/")}
          </span>
        )}
      </footer>
    </article>
  );
}

export function PluginsModal({
  speech,
  pluginsDir,
  voice,
  onVoice,
  onClose,
}: {
  speech: SpeechController;
  /** Where the person drops a plugin — shown so there is no guessing. */
  pluginsDir: string | null;
  voice: string | null;
  onVoice: (voice: string | null) => void;
  onClose: () => void;
}) {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [state, setState] = useState<SpeechState>(() => speech.get());
  useEffect(() => speech.subscribe(setState), [speech]);

  const refresh = useCallback(async () => {
    try {
      setPlugins(await listPlugins());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // A starting plugin becomes running on its own; keep the list honest.
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = (plugin: PluginInfo) =>
    void (async () => {
      setBusy(plugin.name);
      try {
        setPlugins(plugin.enabled ? await disablePlugin(plugin.name) : await enablePlugin(plugin.name));
      } catch (err) {
        await alertDialog(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    })();

  const rescan = () =>
    void (async () => {
      setBusy("rescan");
      try {
        setPlugins(await rescanPlugins());
      } catch (err) {
        await alertDialog(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    })();

  const provider = plugins ? providerOf(plugins, "speech/1") : null;
  const starting = plugins?.some((p) => p.enabled && p.status.kind === "starting") ?? false;
  const voices = provider?.voices ?? [];
  const voiceStatus = !provider
    ? starting
      ? { label: "voice plugin starting…", tone: "wait" as const }
      : { label: "no voice plugin running", tone: "off" as const }
    : !state.enabled
      ? { label: `ready — ${provider.name}`, tone: "wait" as const }
      : state.muted
        ? { label: "muted", tone: "off" as const }
        : state.speaking
          ? { label: "speaking", tone: "on" as const }
          : { label: `on — ${provider.name}`, tone: "on" as const };

  return (
    <div className="docent-modal-backdrop" onClick={onClose}>
      <div className="docent-modal docent-plugins" onClick={(e) => e.stopPropagation()}>
        <header className="docent-modal-header docent-plugins-header">
          <span>Plugins</span>
          <span className="docent-plugins-sub">
            Local providers the desktop app starts and stops.{" "}
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              How to build one ↗
            </a>
          </span>
        </header>

        <section className={"docent-voice-card is-" + voiceStatus.tone}>
          <span className="docent-plugin-icon docent-voice-icon" aria-hidden>
            {state.enabled && !state.muted ? "🔊" : "🔈"}
          </span>
          <div className="docent-voice-body">
            <div className="docent-voice-head">
              <strong>Voice</strong>
              <span className={"docent-status is-" + voiceStatus.tone}>
                <span className="docent-status-dot" />
                {voiceStatus.label}
              </span>
            </div>
            {!provider ? (
              <p className="docent-voice-hint">
                Narration is spoken by a <code>speech/1</code> plugin.{" "}
                {starting
                  ? "The engine is loading its model — a first start also downloads it."
                  : "Switch one on below, or install one."}
              </p>
            ) : !state.enabled ? (
              <div className="docent-voice-controls">
                <button className="docent-primary" onClick={() => speech.enable()}>
                  Enable voice
                </button>
                <span className="docent-voice-hint">
                  One click, once per session — the browser plays no sound without it.
                </span>
              </div>
            ) : (
              <div className="docent-voice-controls">
                <label className="docent-voice-toggle">
                  <Switch
                    checked={!state.muted}
                    onChange={(on) => speech.setMuted(!on)}
                    label={state.muted ? "Unmute narration" : "Mute narration"}
                  />
                  <span>Speak narration</span>
                  <span className="docent-kbd" title="During a presentation">
                    M
                  </span>
                </label>
                {voices.length > 0 && (
                  <label className="docent-voice-pick">
                    <span>Voice</span>
                    <select value={voice ?? ""} onChange={(e) => onVoice(e.target.value || null)}>
                      <option value="">provider default</option>
                      {voices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.id}
                          {v.license ? ` · ${v.license}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <span className="docent-voice-actions">
                  {state.speaking ? (
                    <button onClick={() => speech.cancel()}>■ Stop</button>
                  ) : (
                    <button disabled={state.muted} onClick={() => void speech.speak(SAMPLE_LINE)}>
                      ▶ Try the voice
                    </button>
                  )}
                  <button className="docent-quiet" onClick={() => speech.disable()}>
                    Turn off
                  </button>
                </span>
              </div>
            )}
            {state.error && <p className="docent-plugin-problem">{state.error}</p>}
          </div>
        </section>

        <section className="docent-plugins-list">
          <h3>
            <span>Installed</span>
            <button className="docent-quiet" disabled={busy !== null} onClick={rescan}>
              ↻ Rescan
            </button>
          </h3>
          {error && <p className="docent-plugin-problem">{error}</p>}
          {plugins && plugins.length === 0 && (
            <div className="docent-plugins-empty">
              <p>
                No plugins yet. A plugin is a folder with a <code>docent-plugin.json</code>
                {pluginsDir ? " dropped into" : " in the app's plugins folder."}
              </p>
              {pluginsDir && <code className="docent-plugins-path">{pluginsDir}</code>}
              <p>
                The first one is{" "}
                <a href={FIRST_PLUGIN_URL} target="_blank" rel="noreferrer">
                  docent-pocket-tts
                </a>{" "}
                — a local voice for narration.
              </p>
            </div>
          )}
          {plugins?.map((plugin) => (
            <PluginCard key={plugin.name} plugin={plugin} busy={busy !== null} onToggle={toggle} />
          ))}
          {pluginsDir && plugins && plugins.length > 0 && (
            <p className="docent-plugins-where">
              Folder: <code className="docent-plugins-path">{pluginsDir}</code>
            </p>
          )}
        </section>

        <div className="docent-modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

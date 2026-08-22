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
import type { SpeechController, SpeechState } from "../speech/controller";
import { alertDialog } from "./dialogs";

const SAMPLE_LINE =
  "Requests land at the gateway first; every order is verified before it reaches payments.";

function statusText(plugin: PluginInfo): string {
  switch (plugin.status.kind) {
    case "running":
      return "running";
    case "starting":
      return "starting…";
    case "stopped":
      return plugin.enabled ? "stopped" : "off";
    case "failed":
      return `failed — ${plugin.status.detail}`;
    case "refused":
      return `refused — ${plugin.status.detail}`;
  }
}

function licenseText(license: unknown): string {
  if (typeof license === "string") return license;
  if (license && typeof license === "object") {
    return Object.entries(license as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(" · ");
  }
  return "";
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
  const voices = provider?.voices ?? [];

  return (
    <div className="docent-modal-backdrop" onClick={onClose}>
      <div className="docent-modal docent-plugins" onClick={(e) => e.stopPropagation()}>
        <header className="docent-modal-header">
          <span>Plugins</span>
        </header>

        <section className="docent-plugins-section">
          <h3>Voice</h3>
          {!provider ? (
            <p className="docent-modal-hint">
              Narration is spoken by a <code>speech/1</code> plugin. None is running —
              install one below and switch it on.
            </p>
          ) : (
            <div className="docent-plugins-voice">
              {!state.enabled ? (
                <button
                  className="docent-primary"
                  onClick={() => speech.enable()}
                  title="One click is what the browser needs before it may play sound"
                >
                  🔊 Enable voice
                </button>
              ) : (
                <>
                  <label className="docent-check">
                    <input
                      type="checkbox"
                      checked={!state.muted}
                      onChange={(e) => speech.setMuted(!e.target.checked)}
                    />
                    Speak narration (M mutes during a presentation)
                  </label>
                  {voices.length > 0 && (
                    <label className="docent-field">
                      Voice
                      <select value={voice ?? ""} onChange={(e) => onVoice(e.target.value || null)}>
                        <option value="">provider default</option>
                        {voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.id}
                            {v.license ? ` (${v.license})` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    disabled={state.muted || state.speaking}
                    onClick={() => void speech.speak(SAMPLE_LINE)}
                  >
                    {state.speaking ? "Speaking…" : "Try the voice"}
                  </button>
                  <button disabled={!state.speaking} onClick={() => speech.cancel()}>
                    Stop
                  </button>
                  <button onClick={() => speech.disable()} title="Back to silent">
                    Turn off
                  </button>
                </>
              )}
              {state.error && <span className="docent-portfolio-github-warn">{state.error}</span>}
            </div>
          )}
        </section>

        <section className="docent-plugins-section">
          <h3>
            Installed
            <button className="docent-plugins-rescan" disabled={busy !== null} onClick={rescan}>
              Rescan
            </button>
          </h3>
          {error && <p className="docent-portfolio-github-warn">{error}</p>}
          {plugins && plugins.length === 0 && (
            <p className="docent-modal-hint">
              No plugins yet. A plugin is a folder with a <code>docent-plugin.json</code>
              {pluginsDir ? (
                <>
                  {" "}
                  dropped into <code>{pluginsDir}</code>.
                </>
              ) : (
                " in the app's plugins folder."
              )}{" "}
              The first one is{" "}
              <a href="https://github.com/happyren/docent-pocket-tts" target="_blank" rel="noreferrer">
                docent-pocket-tts
              </a>
              , a local voice.
            </p>
          )}
          {plugins?.map((plugin) => (
            <div key={plugin.name} className="docent-plugin-row">
              <div className="docent-plugin-head">
                <strong>{plugin.name}</strong>
                <span className="docent-portfolio-meta">{plugin.version}</span>
                <span className="docent-portfolio-meta">{plugin.contracts.join(", ")}</span>
                <span
                  className={
                    "docent-plugin-status" +
                    (plugin.status.kind === "running"
                      ? " is-running"
                      : plugin.status.kind === "failed" || plugin.status.kind === "refused"
                        ? " is-failed"
                        : "")
                  }
                >
                  {statusText(plugin)}
                </span>
                <label className="docent-check docent-plugin-switch">
                  <input
                    type="checkbox"
                    checked={plugin.enabled}
                    disabled={busy !== null || plugin.status.kind === "refused"}
                    onChange={() => toggle(plugin)}
                  />
                  on
                </label>
              </div>
              {plugin.description && <p className="docent-plugin-text">{plugin.description}</p>}
              {plugin.license != null && (
                <p className="docent-plugin-text docent-portfolio-meta">
                  License — {licenseText(plugin.license)}
                </p>
              )}
              <p className="docent-plugin-text docent-portfolio-meta">
                {plugin.homepage && (
                  <a href={plugin.homepage} target="_blank" rel="noreferrer">
                    home
                  </a>
                )}
                {plugin.homepage && plugin.log && " · "}
                {plugin.log && <span title={plugin.log}>log: {plugin.log}</span>}
                {plugin.status.kind === "running" && (
                  <>
                    {" · "}
                    <code>{pluginUrl(plugin.name, "/")}</code>
                  </>
                )}
              </p>
            </div>
          ))}
        </section>

        <div className="docent-modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Settings (D115): the person's switches, consolidated on the settings chord.
 * Nothing here has its own state — every control reads the app's and runs the
 * same handler its menu twin runs (B4), so the dialog can never disagree with
 * the menus about what is on.
 */
import type { ReactNode } from "react";

import { Switch } from "./PluginsModal";

export interface SettingsModalProps {
  /** The canvas theme the chrome is already following (D107). */
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  detailMarkers: boolean;
  onDetailMarkers: (on: boolean) => void;
  agentCanEdit: boolean;
  onAgentCanEdit: (on: boolean) => void;
  /** The desktop shell's own MCP endpoint, null on the web (D34). */
  endpoint: string | null;
  /** The web's manual bridge connect (S8), null on the desktop (D118). */
  onConnectBridge: (() => void) | null;
  onClose: () => void;
}

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="docent-settings-row">
      <div className="docent-settings-copy">
        <strong>{title}</strong>
        <span>{hint}</span>
      </div>
      {children}
    </div>
  );
}

export function SettingsModal({
  theme,
  onTheme,
  detailMarkers,
  onDetailMarkers,
  agentCanEdit,
  onAgentCanEdit,
  endpoint,
  onConnectBridge,
  onClose,
}: SettingsModalProps) {
  return (
    <div className="docent-modal-backdrop" onClick={onClose}>
      <div className="docent-modal docent-settings" onClick={(e) => e.stopPropagation()}>
        <header className="docent-modal-header">
          <span>Settings</span>
        </header>

        <section className="docent-settings-section">
          <h3>Appearance</h3>
          <Row title="Theme" hint="The canvas decides; the chrome follows.">
            <div className="docent-settings-segment" role="radiogroup" aria-label="Theme">
              {(["light", "dark"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={theme === option}
                  className={theme === option ? "is-active" : ""}
                  onClick={() => onTheme(option)}
                >
                  {option === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </Row>
        </section>

        <section className="docent-settings-section">
          <h3>Diagram</h3>
          <Row
            title="Detail markers"
            hint="The ⌄ badge on components that open a deeper layer."
          >
            <Switch
              checked={detailMarkers}
              onChange={onDetailMarkers}
              label="Detail markers"
            />
          </Row>
        </section>

        <section className="docent-settings-section">
          <h3>Agent</h3>
          <Row
            title="Agent can edit"
            hint="Off, agents may look and narrate but never touch the drawing."
          >
            <Switch
              checked={agentCanEdit}
              onChange={onAgentCanEdit}
              label="Agent can edit"
            />
          </Row>
          {endpoint !== null && (
            <Row
              title="Agent endpoint"
              hint="Where an MCP client reaches this app. Connected automatically."
            >
              <code className="docent-settings-endpoint">{endpoint}/mcp</code>
            </Row>
          )}
          {onConnectBridge !== null && (
            <Row
              title="Agent bridge"
              hint="Reach this canvas from a local MCP server (pnpm mcp)."
            >
              <button
                type="button"
                className="docent-settings-action"
                onClick={onConnectBridge}
              >
                Connect
              </button>
            </Row>
          )}
        </section>

        <footer className="docent-modal-actions">
          <span className="docent-modal-spacer" />
          <button type="button" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Agent bridge (S8): connects the canvas to the local Docent MCP server
 * over HTTP + Server-Sent Events (no runtime dependencies, I7). The MCP
 * server is a thin transport (B4): every tool call arrives here and is
 * executed against the Command API; results post back.
 *
 * The browser is the connecting side, and a missing server must stay
 * quiet: a dead port can't be probed without the browser logging a
 * network error, so attempts back off exponentially (2s → 30s) and go
 * dormant after a 2-minute grace window — one console hint, no endless
 * spam. `reconnect()` (Menu → "Connect agent bridge") restarts the loop
 * any time; a live connection that drops gets a fresh grace window.
 */
import type { CommandAPI } from "../command/api";
import { execute, type AgentShellHooks } from "./execute";

// Same-origin: nginx proxies /bridge to the MCP service in deployments and
// the dev server proxies it to a local `pnpm mcp`. The canvas never needs
// to know where the agent endpoint actually runs.
const BRIDGE_URL = "";
const INITIAL_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;
const GIVE_UP_AFTER_MS = 120_000;

interface BridgeCommand {
  id: string;
  tool: string;
  params: Record<string, unknown>;
}

export interface AgentBridge {
  reconnect(): void;
  dispose(): void;
}

/** Connect to the local MCP bridge, politely. */
export function connectAgentBridge(
  commands: CommandAPI,
  shell: AgentShellHooks,
): AgentBridge {
  let source: EventSource | null = null;
  let retryTimer = 0;
  let retryMs = INITIAL_RETRY_MS;
  let graceStart = performance.now();
  let disposed = false;

  const handleMessage = (event: MessageEvent) => {
    const command = JSON.parse(event.data) as BridgeCommand;
    void (async () => {
      let body: Record<string, unknown>;
      try {
        const result = await execute(commands, shell, command.tool, command.params);
        body = { id: command.id, ok: true, result };
      } catch (err) {
        // The agent hears the message; the console keeps the stack — an
        // agent's failure is the person's to debug too.
        console.warn("Docent: agent tool failed", command.tool, err);
        body = {
          id: command.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      try {
        await fetch(`${BRIDGE_URL}/bridge/result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        // Server went away; the reconnect loop handles it.
      }
    })();
  };

  const open = () => {
    if (disposed) return;
    source = new EventSource(`${BRIDGE_URL}/bridge/events`);
    source.onopen = () => {
      retryMs = INITIAL_RETRY_MS;
      graceStart = performance.now();
      console.info("Docent: agent bridge connected (localhost:3001)");
    };
    source.onmessage = handleMessage;
    source.onerror = () => {
      source?.close();
      source = null;
      if (disposed) return;
      if (performance.now() - graceStart > GIVE_UP_AFTER_MS) {
        console.info(
          "Docent: no agent bridge on localhost:3001 — start one with `pnpm mcp`, then Menu → Connect agent bridge.",
        );
        return; // dormant until reconnect()
      }
      retryTimer = window.setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    };
  };

  open();
  return {
    reconnect: () => {
      if (disposed) return;
      window.clearTimeout(retryTimer);
      source?.close();
      source = null;
      retryMs = INITIAL_RETRY_MS;
      graceStart = performance.now();
      open();
    },
    dispose: () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      source?.close();
      source = null;
    },
  };
}

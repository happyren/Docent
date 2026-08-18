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

const BRIDGE_URL = "http://localhost:3001";
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

async function execute(
  commands: CommandAPI,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case "get_scene_graph":
      return commands.getSceneGraph();
    case "focus":
      await commands.focus(params as { id: string; padding?: number });
      return { focused: (params as { id: string }).id };
    case "highlight":
      commands.highlight(
        params as { ids: string[]; style?: "glow" | "spotlight" | "outline" },
      );
      return { highlighted: (params as { ids: string[] }).ids };
    case "flow":
      await commands.flow(
        params as { path: string[]; speed?: number; loop?: boolean },
      );
      return { pulsed: (params as { path: string[] }).path };
    case "narrate":
      commands.narrate(params as { text: string | null });
      return { narrating: true };
    case "tour": {
      const completed = await commands.tour(
        params as { steps: never[]; stepMs?: number },
      );
      return { stepsCompleted: completed };
    }
    case "clear_effects":
      commands.clearEffects();
      commands.narrate({ text: null });
      return { cleared: true };
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

/** Connect to the local MCP bridge, politely. */
export function connectAgentBridge(commands: CommandAPI): AgentBridge {
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
        const result = await execute(commands, command.tool, command.params);
        body = { id: command.id, ok: true, result };
      } catch (err) {
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

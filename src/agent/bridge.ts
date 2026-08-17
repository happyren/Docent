/**
 * Agent bridge (S8): connects the canvas to the local Docent MCP server
 * over HTTP + Server-Sent Events (no runtime dependencies, I7). The MCP
 * server is a thin transport (B4): every tool call arrives here and is
 * executed against the Command API; results post back.
 *
 * The browser is the connecting side — the app works fine when no MCP
 * server is running (quiet retry with backoff).
 */
import type { CommandAPI } from "../command/api";

const BRIDGE_URL = "http://localhost:3001";

interface BridgeCommand {
  id: string;
  tool: string;
  params: Record<string, unknown>;
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

/** Connect (and keep reconnecting) to the local MCP bridge. */
export function connectAgentBridge(commands: CommandAPI): () => void {
  let source: EventSource | null = null;
  let retryTimer = 0;
  let disposed = false;

  const open = () => {
    if (disposed) return;
    source = new EventSource(`${BRIDGE_URL}/bridge/events`);
    source.onmessage = (event) => {
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
    source.onerror = () => {
      source?.close();
      source = null;
      if (!disposed) {
        retryTimer = window.setTimeout(open, 3000);
      }
    };
  };

  open();
  return () => {
    disposed = true;
    window.clearTimeout(retryTimer);
    source?.close();
  };
}

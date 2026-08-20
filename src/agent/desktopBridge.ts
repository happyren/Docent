/**
 * Desktop agent bridge (S15, D34): the page side of the shell's MCP pipe.
 * The Rust shell accepts JSON-RPC on its loopback /mcp listener and queues
 * the raw bodies; this loop long-polls them off the store server, runs the
 * one shared dispatcher (mcp-core) against the Command API executor, and
 * posts each answer back. The shell is the same process as this page, so
 * the loop starts at launch and simply waits — there is no one to ask and
 * nothing to configure.
 */
import { handleMcpBody } from "../../server/mcp-core.mjs";
import type { CommandAPI } from "../command/api";
import { execute, type AgentShellHooks } from "./execute";

/**
 * The pipe's own base, injected by the shell beside the store's — the MCP
 * listener is a separate fixed-port server so a parked long-poll can never
 * queue behind (or in front of) portfolio traffic.
 */
const MCP_BASE =
  (globalThis as { __DOCENT_MCP_BASE__?: string }).__DOCENT_MCP_BASE__ ?? null;

const RETRY_MS = 2_000;

interface QueuedRequest {
  id: string;
  body: string;
}

export interface DesktopAgentBridge {
  dispose(): void;
}

export function connectDesktopAgentBridge(
  commands: CommandAPI,
  shell: AgentShellHooks,
): DesktopAgentBridge {
  let disposed = false;
  if (MCP_BASE === null) {
    // The endpoint failed to bind at launch — nothing to serve.
    return { dispose: () => {} };
  }

  const answer = async (request: QueuedRequest) => {
    const result = await handleMcpBody(request.body, (tool, params) =>
      execute(commands, shell, tool, params),
    );
    await fetch(`${MCP_BASE}/bridge/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: request.id, ...result }),
    });
  };

  const loop = async () => {
    while (!disposed) {
      try {
        // The shell holds this open until a client asks something (or a
        // ~25s heartbeat elapses) — one quiet connection, no ticking.
        const res = await fetch(`${MCP_BASE}/bridge/poll`, { method: "POST" });
        if (disposed) return;
        if (res.status === 200) {
          const request = (await res.json()) as QueuedRequest;
          // Answer without blocking the poll: a slow tour must not queue
          // the next client request behind it.
          void answer(request).catch(() => {});
          continue;
        }
        if (res.status === 204) continue; // heartbeat — poll again
        await new Promise((r) => setTimeout(r, RETRY_MS));
      } catch {
        if (disposed) return;
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  };
  void loop();

  return {
    dispose: () => {
      disposed = true;
    },
  };
}

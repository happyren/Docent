/**
 * MCP streamable HTTP transport (S8, D7, D19): the real server process in
 * service mode (DOCENT_MCP_HTTP_ONLY, no stdio) on an ephemeral port —
 * initialize handshake with session id, tool discovery, the no-canvas
 * tool-call error, JSON-RPC error semantics, and method gating. This is
 * the exact surface a deployed Docent exposes to any MCP client.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const PORT = 3498;
const MCP = `http://127.0.0.1:${PORT}/mcp`;

let server: ChildProcess;

const rpc = (method: string, params?: unknown, id?: number) =>
  fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      id === undefined
        ? { jsonrpc: "2.0", method, params }
        : { jsonrpc: "2.0", id, method, params },
    ),
  });

beforeAll(async () => {
  server = spawn("node", [path.resolve("server/docent-mcp.mjs")], {
    env: {
      ...process.env,
      DOCENT_BRIDGE_PORT: String(PORT),
      DOCENT_MCP_HTTP_ONLY: "1",
    },
    stdio: ["ignore", "inherit", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mcp did not start")), 5000);
    server.stderr?.on("data", () => {
      clearTimeout(timer);
      resolve();
    });
    server.on("exit", () => reject(new Error("mcp exited early")));
  });
});

afterAll(() => {
  server.kill();
});

describe("mcp streamable http", () => {
  it("survives service mode (no stdio client) and answers initialize", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18" }, 1);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    const body = (await res.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.result.serverInfo.name).toBe("docent");
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("answers notifications with 202 and no body", async () => {
    const res = await rpc("notifications/initialized");
    expect(res.status).toBe(202);
  });

  it("lists all seven tools with docstrings (Q5)", async () => {
    const res = await rpc("tools/list", undefined, 2);
    const body = (await res.json()) as {
      result: { tools: { name: string; description: string }[] };
    };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "clear_effects",
      "flow",
      "focus",
      "get_scene_graph",
      "highlight",
      "narrate",
      "tour",
    ]);
    for (const tool of body.result.tools) {
      expect(tool.description, tool.name).toContain("Example:");
    }
  });

  it("reports no-canvas as a tool error, not a transport failure", async () => {
    const res = await rpc("tools/call", { name: "get_scene_graph", arguments: {} }, 3);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("No canvas connected");
  });

  it("rejects unknown tools and unknown methods per JSON-RPC", async () => {
    const badTool = (await (
      await rpc("tools/call", { name: "nope" }, 4)
    ).json()) as { error: { code: number } };
    expect(badTool.error.code).toBe(-32602);

    const badMethod = (await (await rpc("no/such", undefined, 5)).json()) as {
      error: { code: number };
    };
    expect(badMethod.error.code).toBe(-32601);
  });

  it("gates non-POST methods", async () => {
    expect((await fetch(MCP)).status).toBe(405);
    expect((await fetch(MCP, { method: "DELETE" })).status).toBe(204);
  });

  it("rejects malformed JSON with a parse error", async () => {
    const res = await fetch(MCP, { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

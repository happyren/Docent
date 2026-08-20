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

  it("lists the full tool surface with docstrings (Q5, D35)", async () => {
    const res = await rpc("tools/list", undefined, 2);
    const body = (await res.json()) as {
      result: { tools: { name: string; description: string }[] };
    };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "clear_effects",
      "climb",
      "dive",
      "find",
      "flow",
      "focus",
      "get_mermaid",
      "get_outline",
      "get_scene_graph",
      "get_view",
      "highlight",
      "list_projects",
      "narrate",
      "open_scene",
      "present",
      "read_frame",
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


describe("mcp stdio proxy (clients that require HTTPS remotes)", () => {
  // Drives the proxy exactly as a stdio MCP client would: write JSON-RPC
  // lines to its stdin, read answers from stdout. It forwards to the same
  // server process the HTTP tests use, so this covers the whole path a
  // deployed Docent takes when the client refuses plain-HTTP remotes.
  const send = async (
    proxy: ChildProcess,
    message: unknown,
  ): Promise<Record<string, unknown> | null> => {
    const line = new Promise<Record<string, unknown> | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("proxy timeout")), 8000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (!text) return;
        clearTimeout(timer);
        proxy.stdout?.off("data", onData);
        resolve(JSON.parse(text.split("\n")[0]) as Record<string, unknown>);
      };
      proxy.stdout?.on("data", onData);
    });
    proxy.stdin?.write(`${JSON.stringify(message)}\n`);
    return line;
  };

  let proxy: ChildProcess;

  beforeAll(() => {
    proxy = spawn(
      "node",
      [path.resolve("server/docent-mcp-proxy.mjs"), MCP],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
  });

  afterAll(() => {
    proxy.kill();
  });

  it("relays initialize and tool discovery over stdio", async () => {
    const init = (await send(proxy, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(init.result.serverInfo.name).toBe("docent");
    // D45: every client is told the diagram is tiered and how to read it.
    expect(init.result.instructions).toMatch(/TIERED/);
    expect(init.result.instructions).toMatch(/get_outline/);

    const tools = (await send(proxy, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools).toHaveLength(17);
  });

  it("relays tool calls, including their errors", async () => {
    const call = (await send(proxy, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_scene_graph", arguments: {} },
    })) as { result: { isError?: boolean; content: { text: string }[] } };
    // No canvas is connected in this test, which must read as a tool
    // error travelling back through the proxy — not a dropped message.
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("No canvas connected");
  });

  it("reports an unreachable deployment instead of hanging", async () => {
    const dead = spawn(
      "node",
      [path.resolve("server/docent-mcp-proxy.mjs"), "http://127.0.0.1:3497/mcp"],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    try {
      const answer = (await send(dead, {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/list",
      })) as { error: { code: number; message: string } };
      expect(answer.error.code).toBe(-32001);
      expect(answer.error.message).toContain("Cannot reach Docent");
    } finally {
      dead.kill();
    }
  });
});

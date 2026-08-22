/** Types for the shared MCP dispatcher (D34) — see mcp-core.mjs. */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const SERVER_INFO: { name: string; version: string };
export const INSTRUCTIONS: string;
export const TOOLS: McpTool[];
export const PROMPTS: { name: string; description: string; arguments: { name: string; description: string; required: boolean }[] }[];

export type CallTool = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export function dispatch(
  message: unknown,
  callTool: CallTool,
): Promise<Record<string, unknown> | null>;

export function handleMcpBody(
  body: string,
  callTool: CallTool,
): Promise<{ status: number; json: string | null; initialized: boolean }>;

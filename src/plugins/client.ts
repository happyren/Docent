/**
 * Plugins client (S17, D50): the desktop shell's provider host, reached on
 * its own loopback origin. The base is injected before the SPA loads, like
 * the store's; absent — on the web — there are no plugins and nothing
 * here is ever called. Plugin code never runs in the page: the page sees a
 * listing and proxied routes, nothing else.
 */

/** The host's origin, read when asked: the shell sets it before the page loads. */
export function pluginsBase(): string {
  return (globalThis as { __DOCENT_PLUGINS_BASE__?: string }).__DOCENT_PLUGINS_BASE__ ?? "";
}

/** Whether this shell hosts plugins at all. */
export function hasPlugins(): boolean {
  const caps = (globalThis as { __DOCENT_CAPABILITIES__?: string[] }).__DOCENT_CAPABILITIES__;
  return pluginsBase() !== "" && Array.isArray(caps) && caps.includes("plugins");
}

export type PluginStatus =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "failed"; detail: string }
  | { kind: "refused"; detail: string };

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  contracts: string[];
  enabled: boolean;
  status: PluginStatus;
  license?: unknown;
  voices?: { id: string; license?: string; description?: string }[];
  homepage?: string;
  /** The route the page talks to, relative to the plugins base. */
  route: string;
  log?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(pluginsBase() + path, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`plugins host answered ${res.status} without JSON`);
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function listPlugins(): Promise<PluginInfo[]> {
  return request("/plugins");
}

export function rescanPlugins(): Promise<PluginInfo[]> {
  return request("/plugins/rescan", { method: "POST" });
}

export function enablePlugin(name: string): Promise<PluginInfo[]> {
  return request(`/plugins/${encodeURIComponent(name)}/enable`, { method: "POST" });
}

export function disablePlugin(name: string): Promise<PluginInfo[]> {
  return request(`/plugins/${encodeURIComponent(name)}/disable`, { method: "POST" });
}

/** The absolute URL of a route on a plugin, e.g. `pluginUrl("pocket-tts", "/tts")`. */
export function pluginUrl(name: string, path: string): string {
  return `${pluginsBase()}/plugins/${encodeURIComponent(name)}${path}`;
}

/** The first running plugin that fulfils a contract, or null. */
export function providerOf(plugins: PluginInfo[], contract: string): PluginInfo | null {
  return (
    plugins.find((p) => p.enabled && p.status.kind === "running" && p.contracts.includes(contract)) ??
    null
  );
}

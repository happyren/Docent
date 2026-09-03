/**
 * Native file dialogs for the desktop shell (S13). The system webview has no
 * File System Access API and ignores anchor downloads, so the browser paths in
 * scene-file.ts are dead ends there — a real file can only be read or written
 * by the Rust side. These two calls ask the shell's loopback store to raise the
 * platform dialog and do the I/O.
 *
 * On the web `API_BASE` is empty, nothing here is ever called, and the browser
 * file paths remain the only ones.
 */
import { API_BASE } from "../portfolio/client";

export interface ImportedSceneFile {
  /** The picked file's own name, extension included. */
  name: string;
  content: string;
}

/**
 * One POST to the shell's loopback store, parsed as the JSON answer it owes.
 * Exported because the message boxes in dialogs.ts are the same conversation
 * with the same shell — every `/desktop/*` endpoint answers this shape, and a
 * second copy of the parsing would be a second place for it to drift.
 */
export async function postToShell<T>(path: string, body?: string): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Anything but the shell answering — a dev server's SPA fallback, say.
    throw new Error("the desktop shell did not answer");
  }
  if (!res.ok) {
    throw new Error(
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`,
    );
  }
  return parsed as T;
}

/** Raise the open dialog and read what the user picked. Null when cancelled. */
export async function importSceneFile(): Promise<ImportedSceneFile | null> {
  const result = await postToShell<{
    name?: string;
    content?: string;
    canceled?: boolean;
  }>("/desktop/import");
  if (result.canceled || typeof result.content !== "string") return null;
  return { name: result.name ?? "", content: result.content };
}

/**
 * Raise the folder picker and link a project to the chosen directory (S25,
 * D146): the picked directory is the diagram directory, and the project takes
 * the folder's name. Null when cancelled.
 */
export async function linkProjectFolder(): Promise<{ project: string; root: string } | null> {
  const result = await postToShell<{ project?: string; root?: string; canceled?: boolean }>(
    "/desktop/link-project",
  );
  if (result.canceled || typeof result.project !== "string" || typeof result.root !== "string") {
    return null;
  }
  return { project: result.project, root: result.root };
}

/**
 * Open a plugin's face (D151): the shell opens a native window at the
 * plugin's loopback URL beside the canvas. False when the shell refused.
 */
export async function openPluginPanel(title: string, url: string): Promise<boolean> {
  const result = await postToShell<{ opened?: boolean }>(
    "/desktop/open-panel",
    JSON.stringify({ title, url }),
  );
  return result.opened === true;
}

/** Raise the save dialog and write `content`. False when cancelled. */
export async function exportSceneFile(
  name: string,
  content: string,
): Promise<boolean> {
  const result = await postToShell<{ saved?: string; canceled?: boolean }>(
    "/desktop/export",
    JSON.stringify({ name, content }),
  );
  return typeof result.saved === "string";
}

/**
 * The same save dialog for bytes (D116): the channel is JSON, so the bytes
 * ride base64 and the shell decodes before it writes. The PDF is the caller;
 * anything binary the page ever exports goes this way.
 */
export async function exportSceneBytes(
  name: string,
  bytes: Uint8Array,
): Promise<boolean> {
  // btoa over the raw latin-1 string, fed in slices — one giant
  // String.fromCharCode(...bytes) call would blow the argument limit.
  let raw = "";
  const STEP = 0x8000;
  for (let at = 0; at < bytes.length; at += STEP) {
    raw += String.fromCharCode(...bytes.subarray(at, at + STEP));
  }
  const result = await postToShell<{ saved?: string; canceled?: boolean }>(
    "/desktop/export",
    JSON.stringify({ name, content: btoa(raw), encoding: "base64" }),
  );
  return typeof result.saved === "string";
}

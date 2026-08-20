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

async function dialog<T>(path: string, body?: string): Promise<T> {
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
  const result = await dialog<{
    name?: string;
    content?: string;
    canceled?: boolean;
  }>("/desktop/import");
  if (result.canceled || typeof result.content !== "string") return null;
  return { name: result.name ?? "", content: result.content };
}

/** Raise the save dialog and write `content`. False when cancelled. */
export async function exportSceneFile(
  name: string,
  content: string,
): Promise<boolean> {
  const result = await dialog<{ saved?: string; canceled?: boolean }>(
    "/desktop/export",
    JSON.stringify({ name, content }),
  );
  return typeof result.saved === "string";
}

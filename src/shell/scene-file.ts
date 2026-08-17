/**
 * Browser file I/O for `.excalidraw` scenes. Uses the File System Access API
 * where available (Chromium) so "Save" writes back to the opened file, and
 * falls back to <input type=file> / anchor downloads elsewhere.
 */

export interface OpenedSceneFile {
  blob: Blob;
  name: string;
  /** Present only when the File System Access API is available. */
  handle: FileSystemFileHandle | null;
}

const PICKER_TYPES = [
  {
    description: "Excalidraw scene",
    accept: { "application/json": [".excalidraw", ".json"] as const },
  },
];

interface PickerWindow extends Window {
  showOpenFilePicker?(options?: unknown): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options?: unknown): Promise<FileSystemFileHandle>;
}

const win = window as PickerWindow;

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** Ask the user for a scene file. Resolves null if they cancel. */
export async function pickSceneFile(): Promise<OpenedSceneFile | null> {
  if (win.showOpenFilePicker) {
    try {
      const [handle] = await win.showOpenFilePicker({ types: PICKER_TYPES });
      const file = await handle.getFile();
      return { blob: file, name: file.name, handle };
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".excalidraw,.json,application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? { blob: file, name: file.name, handle: null } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Ask the user where to save. Resolves null when cancelled, or "download" when the fallback path was used. */
export async function pickSaveTarget(
  suggestedName: string,
): Promise<FileSystemFileHandle | "download" | null> {
  if (win.showSaveFilePicker) {
    try {
      return await win.showSaveFilePicker({
        suggestedName,
        types: PICKER_TYPES,
      });
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
  }
  return "download";
}

export async function writeSceneFile(
  handle: FileSystemFileHandle,
  contents: string,
): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

export function downloadSceneFile(name: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ensureExtension(name: string): string {
  return name.endsWith(".excalidraw") ? name : `${name}.excalidraw`;
}

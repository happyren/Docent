/**
 * The trail the title bar reads (D136): the open scene's name split the way
 * D92 writes it — project first, folders between, scene last — with the
 * file extension dropped. A local file is a single step; nothing addressed
 * yet is "Untitled". Pure, so the readout is testable without a window.
 */
export function sceneTrail(fileName: string | null): string[] {
  const name = (fileName ?? "").replace(/\.excalidraw$/i, "").trim();
  if (!name) return ["Untitled"];
  const parts = name
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : ["Untitled"];
}

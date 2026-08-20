/**
 * Asking the user something, in both places Docent runs (S13).
 *
 * The system webview implements none of `window.confirm`, `window.alert` or
 * `window.prompt`: confirm() answers false instantly with no box on screen and
 * alert() vanishes. Every destructive action in this app is confirm-gated and
 * every failure is reported by an alert, so in the desktop shell the gates all
 * refused silently and the messages were invisible. These two calls ask the
 * shell's loopback store to raise the platform's own message box instead
 * (src-tauri/src/store.rs), which is the same route the native file dialogs
 * already take.
 *
 * On the web the flag is absent and these are the browser's own dialogs,
 * called with the same string. The browser call is still synchronous: an async
 * function body runs up to its first `await`, and on the web neither of these
 * reaches one — so the box still opens inside the click that asked for it,
 * which is the gesture browsers require, and the caller resumes on a microtask,
 * before rendering or any other task. Nothing about the web experience changes
 * but the shape of the call.
 */
import { postToShell } from "./desktop-files";

/**
 * The desktop shell announces itself before the page loads, the same way
 * App.tsx reads it. Absent — i.e. on the web — the browser's dialogs are the
 * only ones there are.
 */
const isDesktop = Boolean(
  (window as { __DOCENT_DESKTOP__?: boolean }).__DOCENT_DESKTOP__,
);

/** `window.confirm`, answered by a native message box in the desktop shell. */
export async function confirmDialog(message: string): Promise<boolean> {
  if (!isDesktop) return window.confirm(message);
  try {
    const result = await postToShell<{ confirmed?: boolean }>(
      "/desktop/confirm",
      JSON.stringify({ message }),
    );
    return result.confirmed === true;
  } catch (err) {
    // A dialog channel that is not answering must never read as approval: the
    // user was never asked, so the answer is no and the caller stops. The
    // alternative — defaulting to true — would delete things nobody confirmed.
    console.error("Could not ask for confirmation", err);
    return false;
  }
}

/** `window.alert`, likewise. Resolves once the user has dismissed the box. */
export async function alertDialog(message: string): Promise<void> {
  if (!isDesktop) {
    window.alert(message);
    return;
  }
  try {
    await postToShell<{ ok?: boolean }>(
      "/desktop/alert",
      JSON.stringify({ message }),
    );
  } catch (err) {
    // Nothing to fall back to — an alert that cannot be shown is at least kept
    // where a developer can find it, with the message it was carrying.
    console.error("Could not show:", message, err);
  }
}

import open from 'open';

/**
 * Best-effort browser open, shared by `login` and `publish`. The caller always
 * prints the URL too, so a failure here (headless box, SSH, no DISPLAY) is
 * non-fatal — the user can open it manually.
 */
export async function openBrowser(url) {
  try {
    const child = await open(url);
    // Detach so a one-shot CLI process isn't held open by the browser handle.
    child.unref?.();
  } catch {
    /* ignore — the URL is printed regardless */
  }
}

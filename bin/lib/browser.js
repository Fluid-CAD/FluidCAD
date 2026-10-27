import open from 'open';

/**
 * Best-effort browser open, shared by `login` and `publish`. The caller always
 * prints the URL too, so a failure here (headless box, SSH, no DISPLAY) is
 * non-fatal — the user can open it manually. `FLUIDCAD_NO_BROWSER=1` skips
 * the open altogether (the URL is still printed): for machines where opening
 * a browser does the wrong thing, and for the CLI tests, which play the
 * browser themselves.
 */
export async function openBrowser(url) {
  if (process.env.FLUIDCAD_NO_BROWSER === '1') {
    return;
  }
  try {
    const child = await open(url);
    // Detach so a one-shot CLI process isn't held open by the browser handle.
    child.unref?.();
  } catch {
    /* ignore — the URL is printed regardless */
  }
}

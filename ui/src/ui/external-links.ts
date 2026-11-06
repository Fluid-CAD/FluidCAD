/**
 * Opening a web page in the user's browser from the page, in every host
 * (hub-plan H11: the Hub panel's "Open on the hub" and part Previews).
 *
 * - **A page shown on its own** (the desktop shell, a browser tab, the
 *   browser tab Neovim opens) calls `window.open`: the desktop shell hands
 *   every new window to the system browser, a browser opens a tab.
 * - **A page framed inside an editor** (VS Code's webview, which allows no
 *   popups) asks the engine to relay an `open-external` host message
 *   (`POST /api/host/open-external`); the attached host opens it. When no
 *   host takes it, the page tries `window.open` after all.
 *
 * Only `http:` and `https:` URLs are opened.
 */
export class ExternalLinks {
  /** Whether `url` is a web page this may open. */
  static isWebUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /** Open `url` in the user's browser; resolves once it is handed on (or refused). */
  static async open(url: string): Promise<void> {
    if (!ExternalLinks.isWebUrl(url)) {
      return;
    }
    if (!ExternalLinks.framed()) {
      ExternalLinks.popup(url);
      return;
    }
    let delivered = false;
    try {
      const res = await fetch('api/host/open-external', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      delivered = res.ok && (await res.json().catch(() => null))?.delivered === true;
    } catch {
      delivered = false;
    }
    if (!delivered) {
      ExternalLinks.popup(url);
    }
  }

  /** In a frame: a parent page owns the window (an editor's webview, an embed). */
  private static framed(): boolean {
    try {
      return window.parent !== window;
    } catch {
      return true;
    }
  }

  private static popup(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

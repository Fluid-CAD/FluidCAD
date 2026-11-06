import { Router } from 'express';
import type { HostSend } from '../host-registry.ts';

/**
 * What the page asks of whichever editor host is attached that isn't an
 * edit (hub-plan H11).
 *
 * - `POST /api/host/open-external { url }`: open an `http(s)` page in the
 *   user's own browser ("Open on the hub", a part's Preview). A page shown
 *   on its own (the desktop shell, a browser tab, Neovim's browser tab)
 *   opens links itself; a page framed inside an editor can't (VS Code's
 *   webview allows no popups), so it asks here, and the host opens it:
 *   VS Code with `vscode.env.openExternal`, Neovim with the system's opener,
 *   the in-page host with `window.open`. Answers `{ delivered }`: false when
 *   no editor host has announced itself (`editor-hello`) or none took the
 *   message, so the page falls back to opening it itself. (The host
 *   registry's last resort, the bare IPC channel `fluidcad serve` forks the
 *   engine with, is no editor: nothing there would open the page.)
 */
export type HostActionsDeps = {
  /** The host send (`HostRegistry.send`, behind the package edit guard). */
  send: HostSend;
  /** Whether an editor host announced itself, so a message has someone to act on it. */
  hasHost(): boolean;
};

export function createHostActionsRouter(deps: HostActionsDeps): Router {
  const router = Router();

  router.post('/host/open-external', (req, res) => {
    const url = HostActions.httpUrl(req.body?.url);
    if (url === null) {
      res.status(400).json({ error: 'Expected { url: "https://…" }: only web pages open in the browser.', code: 'bad-request' });
      return;
    }
    res.json({ delivered: deps.hasHost() && deps.send({ type: 'open-external', url }) === true });
  });

  return router;
}

class HostActions {
  /** The URL as a canonical string when it is `http:` or `https:`; null otherwise. */
  static httpUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 4096) {
      return null;
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  }
}

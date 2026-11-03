import { endAssemblyPreview } from '../../api';

/**
 * The tokens of assembly preview dialogs: one per dialog session, kept in
 * this tab's `sessionStorage` while it may be showing, so a reloaded page
 * can end the preview it left behind (the server replays a preview's scene
 * to a page that connects while it shows). Only the tab that asked for a
 * preview ends it: other pages see it and leave it.
 */
export class PreviewTokens {
  static readonly KEY = 'fluidcad.assemblyPreviewToken';

  /** A fresh token, remembered as this tab's. */
  static create(): string {
    const token = PreviewTokens.random();
    PreviewTokens.write(token);
    return token;
  }

  /** The dialog is done with `token` (ended or applied): forget it, unless another took its place. */
  static release(token: string): void {
    if (PreviewTokens.read() === token) {
      PreviewTokens.write(null);
    }
  }

  /** The token this tab left behind, if any. */
  static orphan(): string | null {
    return PreviewTokens.read();
  }

  /**
   * At startup: end the preview this tab left showing when it was
   * reloaded or navigated away mid-dialog, and forget it.
   */
  static async endOrphan(end: (token: string) => Promise<unknown> = endAssemblyPreview): Promise<void> {
    const token = PreviewTokens.read();
    if (token === null) {
      return;
    }
    PreviewTokens.write(null);
    await end(token);
  }

  private static random(): string {
    const crypto = (globalThis as { crypto?: Crypto }).crypto;
    if (crypto?.randomUUID) {
      return crypto.randomUUID();
    }
    return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  private static read(): string | null {
    try {
      return window.sessionStorage?.getItem(PreviewTokens.KEY) ?? null;
    } catch {
      return null;
    }
  }

  private static write(token: string | null): void {
    try {
      if (token === null) {
        window.sessionStorage?.removeItem(PreviewTokens.KEY);
      } else {
        window.sessionStorage?.setItem(PreviewTokens.KEY, token);
      }
    } catch {
      // Storage refused (private mode): the reload case just isn't covered.
    }
  }
}

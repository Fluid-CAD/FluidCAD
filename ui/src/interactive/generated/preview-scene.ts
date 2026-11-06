type Listener = (token: string | null) => void;

/**
 * Whether the scene on screen is an assembly preview (G4): a render of the
 * open assembly with a dialog's insert or values edit applied in memory,
 * sent as `scene-rendered` with `preview: { token }`. Fed by main.ts from
 * every scene the page applies.
 *
 * The rules while a preview shows, whoever's dialog asked for it (every
 * page sees it):
 * - nothing on this page writes a row: the parts, joints and connectors
 *   panels are read-only and a dragged part's pose is never written back —
 *   the rows are the previewed code's, whose lines are not the editor's
 *   (an insert's import shifts them), and the server does not refuse
 *   writes during a preview;
 * - the editor's markers are left as they are (they would be placed by the
 *   previewed code's lines);
 * - moving a part still solves its joints: driving a joint writes nothing.
 */
class PreviewSceneStore {
  private current: string | null = null;
  private readonly listeners = new Set<Listener>();

  /** The token of the preview on screen, or null for the file's own scene. */
  get token(): string | null {
    return this.current;
  }

  /** The scene on screen is a preview. */
  get active(): boolean {
    return this.current !== null;
  }

  /** The scene just applied: its preview token, or null. Listeners hear a change only. */
  set(token: string | null): void {
    if (token === this.current) {
      return;
    }
    this.current = token;
    for (const listener of this.listeners) {
      listener(token);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const previewScene = new PreviewSceneStore();

import { SceneMeshes, type SceneMeshEntry } from './scene-meshes.ts';
import type { MeshLedger } from './mesh-ledger.ts';

/**
 * One `scene-rendered` message on its way to the pages, serialized per
 * receiver: whole for a client without a mesh cache (an older page, the
 * MCP's socket, a page before its hello) and for the replay to a page that
 * connects later; with `meshRef`s for a page whose ledger holds keys
 * (S6b). The whole text is made once, when first asked — never, while
 * every connected page has a mesh cache and no page connects before the
 * next scene. The message is not modified: the rows a scene carries are
 * not changed once sent.
 */
export class OutgoingScene {
  readonly entries: SceneMeshEntry[];
  private fullText: string | null = null;

  constructor(readonly msg: Record<string, unknown>) {
    this.entries = SceneMeshes.entriesOf(msg);
  }

  /** The whole message. */
  full(): string {
    this.fullText ??= JSON.stringify(this.msg);
    return this.fullText;
  }

  /** The text for a page with a mesh cache: a reference for every key `ledger` holds. */
  forPage(ledger: MeshLedger): string {
    const { msg, refs } = SceneMeshes.forPage(this.msg, ledger);
    return refs > 0 ? JSON.stringify(msg) : this.full();
  }

  /** `ledger`'s page was sent this scene: every key it carries, whole or referenced, is the most recent. */
  noteSent(ledger: MeshLedger): void {
    for (const entry of this.entries) {
      ledger.note(entry.key, entry.weight);
    }
  }
}

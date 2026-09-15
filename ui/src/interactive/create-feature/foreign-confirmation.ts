import type { ForeignPick } from '../../api';

/**
 * The cross-part gate of a pick dialog: the preview reports which picks
 * belong to other parts, the dialog raises a gentle notice, and Apply waits
 * for the user's go-ahead. The confirmation is bound to the exact pick set
 * it was given for — a changed set (another foreign pick, one removed) asks
 * again; picks the sketch's own part owns never do. Pure state, no DOM.
 */
export class ForeignConfirmation {
  /**
   * How the notice names what Apply does with the references — the
   * projection dialog "projects" them, its intersect mode "intersects" them.
   */
  wording: { verb: string; gerund: string } = { verb: 'projects', gerund: 'Projecting' };

  private picks: ForeignPick[] = [];
  private confirmedSignature: string | null = null;

  /** The latest preview's foreign picks (none when the response carried no `foreign`). */
  update(picks: ForeignPick[] | undefined): void {
    this.picks = picks ?? [];
    if (this.confirmedSignature !== null && this.confirmedSignature !== this.signature()) {
      this.confirmedSignature = null;
    }
  }

  /** The user accepted the notice for the current picks. */
  confirm(): void {
    if (this.picks.length > 0) {
      this.confirmedSignature = this.signature();
    }
  }

  reset(): void {
    this.picks = [];
    this.confirmedSignature = null;
  }

  /** Some picks belong to other parts. */
  get present(): boolean {
    return this.picks.length > 0;
  }

  /** The current foreign picks were confirmed. */
  get confirmed(): boolean {
    return this.present && this.confirmedSignature === this.signature();
  }

  /** Foreign picks await the user's go-ahead. */
  get pending(): boolean {
    return this.present && !this.confirmed;
  }

  /** The message blocking Apply while the picks await confirmation. */
  blockReason(): string | null {
    return this.pending ? `Confirm the geometry from ${this.partList()} first.` : null;
  }

  /**
   * The notice: what was picked, which part owns it, and what Apply does
   * about it — an `expose()` written into the owner unless it already
   * publishes the geometry.
   */
  message(): string | null {
    if (!this.present) {
      return null;
    }
    const plural = this.picks.length > 1;
    const what = `${this.describePicks()} belong${plural ? '' : 's'} to ${this.partPhrase()}`;
    const references = plural ? 'the references' : 'the reference';
    const existing = this.picks.filter(p => p.existing);
    if (existing.length === this.picks.length) {
      const names = [...new Set(existing.map(p => p.exposeName))].join(', ');
      return `${what}, already exposed as ${names}. Apply ${this.wording.verb} ${references} here.`;
    }
    const parts = this.partNames();
    const where = parts.length > 1 ? 'in each' : 'there';
    const verb = existing.length > 0 ? `exposes what isn't yet ${where}` : `adds expose() ${where}`;
    return `${what}. Apply ${verb} and ${this.wording.verb} ${references} here.`;
  }

  /** The compact line shown once confirmed. */
  summary(): string | null {
    return this.present ? `${this.wording.gerund} from ${this.partList()} through expose().` : null;
  }

  private signature(): string {
    return this.picks.map(p => `${p.shapeId}/${p.sub.type}/${p.sub.index}`).sort().join('|');
  }

  private partNames(): string[] {
    return [...new Set(this.picks.map(p => p.partName))];
  }

  /** `"Bracket"`, `"Bracket" and "Base"`, `"A", "B" and "C"`. */
  private partList(): string {
    const quoted = this.partNames().map(n => `"${n}"`);
    if (quoted.length <= 1) {
      return quoted[0] ?? '';
    }
    return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
  }

  private partPhrase(): string {
    return `${this.partNames().length > 1 ? 'parts' : 'part'} ${this.partList()}`;
  }

  /** `1 face`, `2 faces`, `1 face and 2 edges`. */
  private describePicks(): string {
    const faces = this.picks.filter(p => p.sub.type === 'face').length;
    const edges = this.picks.length - faces;
    const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    const words = [
      ...(faces > 0 ? [count(faces, 'face')] : []),
      ...(edges > 0 ? [count(edges, 'edge')] : []),
    ];
    return words.join(' and ');
  }
}

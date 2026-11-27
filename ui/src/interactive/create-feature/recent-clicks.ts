import type { SubSelection } from '../../types';

/** What a viewport click picked: an edge, a face, a sketch's wire. */
export type ClickedPick = { shapeId: string; sub: NonNullable<SubSelection> };

/** Where a double-click's gesture started, read back from the two clicks before it. */
export type GestureStart<R extends string> =
  /** The gesture is the armed row's, grown from the double-click's own pick. */
  | { repaired: false; row: R; seed: ClickedPick }
  /**
   * Its first click filled `row` and handed the border on: the gesture
   * grows `row` from that click's pick, and its second click, which the
   * next row took (`takeBack`; null when it did not), comes back out.
   */
  | { repaired: true; row: R; seed: ClickedPick; takeBack: { row: R; pick: ClickedPick } | null };

/** One viewport click into a row, as a double-click that follows it reads it back. */
type RecentClick<R extends string> = {
  row: R;
  pick: ClickedPick;
  /** The row took it (or took it back off). */
  taken: boolean;
  /** It handed the armed border on to another row. */
  handedOn: boolean;
};

/** The same sub-shape of the same shape. */
function samePick(a: ClickedPick, b: ClickedPick): boolean {
  return a.shapeId === b.shapeId && a.sub.type === b.sub.type && a.sub.index === b.sub.index;
}

/**
 * The last two viewport clicks into a dialog's rows: the two a double-click
 * arrives after, since the viewer delivers a double-click's own clicks
 * first. The first can fill a row and hand the border to the next, empty
 * one, which the second then lands in — on the same pick when both rows
 * pick alike, or on what lies behind the first pick when they do not (the
 * face behind an edge or a sketch's wire, a surface row after a curve row).
 * That second click is the gesture's echo, not a pick of its own: a
 * double-click never fills the next row ({@link gestureStart}).
 */
export class RecentClicks<R extends string> {
  private clicks: RecentClick<R>[] = [];

  /** A click landed in `row`: `taken` when the row took it (or took it back off), `handedOn` when the border then moved on. */
  remember(row: R, pick: ClickedPick, taken: boolean, handedOn: boolean): void {
    this.clicks = [...this.clicks.slice(-1), { row, pick, taken, handedOn }];
  }

  /** A click elsewhere, a fresh dialog: no double-click reads back across it. */
  forget(): void {
    this.clicks = [];
  }

  /**
   * Where a double-click at `pick` started — in the armed row, unless its
   * second click is the echo of a first that handed the border on from
   * another — and what it grows from. Reading it back forgets the clicks.
   */
  gestureStart(armed: R, pick: ClickedPick): GestureStart<R> {
    const [first, second] = this.clicks.length === 2 ? this.clicks : [];
    this.clicks = [];
    if (!first || !second || !first.handedOn || second.row === first.row || !samePick(second.pick, pick)
      || !(samePick(first.pick, pick) || first.pick.sub.type !== pick.sub.type)) {
      return { repaired: false, row: armed, seed: pick };
    }
    return {
      repaired: true,
      row: first.row,
      seed: first.pick,
      takeBack: second.taken ? { row: second.row, pick: second.pick } : null,
    };
  }
}

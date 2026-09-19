import type { LoftConnectionPointRef, LoftConnectionRef } from '../../api';
import type { SelectedEntity } from '../../viewer';
import type { PickSlotChip } from '../pick-slot';

export type ConnectionPoint = [number, number, number];
type PointSlot = { ref: LoftConnectionPointRef; point: ConnectionPoint | null; label?: string };
export type ConnectionRow = { points: (PointSlot | null)[]; sourceIndex?: number; sourceArity?: number };

/** Ordered point slots follow profile identity through add/remove/reorder gestures. */
export class LoftConnections {
  rows: ConnectionRow[] = [];
  active: number | null = null;
  private originalCount = 0;

  seed(texts: string[][]): void {
    this.originalCount = texts.length;
    this.rows = texts.map((points, sourceIndex) => ({
      sourceIndex, sourceArity: points.length,
      points: points.map((label, pointIndex) => ({
        ref: { kind: 'verbatim', sourceIndex, pointIndex }, point: null, label,
      })),
    }));
    this.active = null;
  }

  resolve(points: ConnectionPoint[][]): void {
    for (const row of this.rows) {
      for (const slot of row.points) {
        if (slot?.ref.kind === 'verbatim') {
          slot.point = points[slot.ref.sourceIndex]?.[slot.ref.pointIndex] ?? null;
        }
      }
    }
  }

  /** Mapping is new profile order → previous index; -1 adds an empty point. */
  remap(indices: number[]): void {
    for (const row of this.rows) {
      row.points = indices.map(index => row.points[index] ?? null);
    }
    this.advance();
  }

  /** Pick identities expire with a scene rebuild; original expressions survive. */
  invalidatePicks(): boolean {
    let changed = false;
    for (const row of this.rows) {
      row.points = row.points.map(slot => {
        if (slot?.ref.kind === 'vertex') {
          changed = true;
          return null;
        }
        return slot;
      });
    }
    this.advance();
    return changed;
  }

  pick(profile: number, count: number, entity: SelectedEntity, point: ConnectionPoint): void {
    if (entity.sub.type !== 'vertex' || profile < 0 || profile >= count) {
      return;
    }
    if (this.active === null) {
      this.active = this.rows.length;
      this.rows.push({ points: Array.from({ length: count }, () => null) });
    }
    this.rows[this.active].points[profile] = {
      ref: { kind: 'vertex', entity: { shapeId: entity.shapeId, sub: { type: 'vertex', index: entity.sub.index } } },
      point,
    };
    if (this.rows[this.active].points.every(Boolean)) {
      this.advance();
    }
  }

  edit(index: number): void {
    if (this.rows[index]) {
      this.active = index;
    }
  }

  remove(index: number): void {
    this.rows.splice(index, 1);
    this.advance();
  }

  private advance(): void {
    const next = this.rows.findIndex(row => row.points.some(slot => !slot));
    this.active = next < 0 ? null : next;
  }

  get incomplete(): boolean {
    return this.rows.some(row => row.points.some(slot => !slot));
  }

  get hasPicks(): boolean {
    return this.rows.some(row => row.points.some(slot => slot?.ref.kind === 'vertex'));
  }

  /**
   * The rows as the request carries them. Only finished rows travel: a row
   * still being picked has no place in a statement (Apply is blocked on it),
   * and leaving it out keeps the statement preview and the ghost alive.
   */
  refs(edit: boolean): LoftConnectionRef[] | undefined {
    const refs: LoftConnectionRef[] = this.rows.filter(row => row.points.every(Boolean)).map(row => {
      if (row.sourceIndex !== undefined && row.points.length === row.sourceArity
        && row.points.every((slot, index) => slot?.ref.kind === 'verbatim'
          && slot.ref.sourceIndex === row.sourceIndex && slot.ref.pointIndex === index)) {
        return { kind: 'verbatim', sourceIndex: row.sourceIndex };
      }
      return { kind: 'points', points: row.points.flatMap(slot => slot ? [slot.ref] : []) };
    });
    if (edit && refs.length === this.originalCount
      && refs.every((ref, index) => ref.kind === 'verbatim' && ref.sourceIndex === index)) {
      return undefined;
    }
    return refs;
  }

  /**
   * The finished rows as world points, for the ghost. A row still being
   * picked is left out; a finished row with a point that has no position
   * (an original expression that did not resolve) cannot travel at all — null.
   */
  completeWorldPoints(): ConnectionPoint[][] | null {
    const complete = this.rows.filter(row => row.points.every(Boolean));
    if (complete.some(row => row.points.some(slot => !slot!.point))) {
      return null;
    }
    return complete.map(row => row.points.map(slot => slot!.point!));
  }

  chips(onEdit: (index: number) => void): PickSlotChip[] {
    return this.rows.map((row, index) => ({
      label: `C${index + 1}`,
      badge: row.points.some(slot => !slot) ? `${row.points.filter(Boolean).length}/${row.points.length}` : undefined,
      title: row.points.map((slot, i) => `Profile ${i + 1}: ${slot?.label ?? (slot ? 'Picked vertex' : 'Pick a vertex')}`).join('\n'),
      removable: true,
      active: this.active === index,
      onSelect: () => onEdit(index),
    }));
  }

  prompt(profileCount: number): string {
    if (profileCount < 2) {
      return 'Add at least two profiles first';
    }
    const row = this.active === null ? null : this.rows[this.active];
    const missing = row?.points.flatMap((slot, index) => slot ? [] : [index + 1]);
    if (missing?.length) {
      return `C${this.active! + 1}: pick a vertex on profile${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`;
    }
    return row ? `C${this.active! + 1}: pick a replacement vertex` : 'Pick one vertex per profile to add a connection';
  }
}

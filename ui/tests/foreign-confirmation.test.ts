import { describe, it, expect } from 'vitest';
import { ForeignConfirmation } from '../src/interactive/create-feature/foreign-confirmation';
import type { ForeignPick } from '../src/api';

const face = (index: number, partName = 'Bracket', over: Partial<ForeignPick> = {}): ForeignPick => ({
  shapeId: 'shape-1', sub: { type: 'face', index }, partName, exposeName: `g${index}`, existing: false, ...over,
});
const edge = (index: number, partName = 'Bracket', over: Partial<ForeignPick> = {}): ForeignPick => ({
  shapeId: 'shape-1', sub: { type: 'edge', index }, partName, exposeName: `g${index}`, existing: false, ...over,
});

describe('ForeignConfirmation', () => {
  it('is inert without foreign picks', () => {
    const gate = new ForeignConfirmation();
    expect(gate.present).toBe(false);
    expect(gate.pending).toBe(false);
    expect(gate.blockReason()).toBe(null);
    expect(gate.message()).toBe(null);
    gate.update(undefined);
    expect(gate.present).toBe(false);
    gate.confirm();
    expect(gate.confirmed).toBe(false);
  });

  it('blocks Apply until confirmed, then lets it through', () => {
    const gate = new ForeignConfirmation();
    gate.update([face(0)]);
    expect(gate.pending).toBe(true);
    expect(gate.blockReason()).toBe('Confirm the geometry from "Bracket" first.');
    gate.confirm();
    expect(gate.confirmed).toBe(true);
    expect(gate.pending).toBe(false);
    expect(gate.blockReason()).toBe(null);
    expect(gate.summary()).toBe('Projecting from "Bracket" through expose().');
  });

  it('words the notice for the intersect statement when told to', () => {
    const gate = new ForeignConfirmation();
    gate.wording = { verb: 'intersects', gerund: 'Intersecting' };
    gate.update([face(0)]);
    expect(gate.message()).toBe(
      '1 face belongs to part "Bracket". Apply adds expose() there and intersects the reference here.',
    );
    gate.confirm();
    expect(gate.summary()).toBe('Intersecting from "Bracket" through expose().');
  });

  it('keeps a confirmation across an unchanged set and drops it when the set changes', () => {
    const gate = new ForeignConfirmation();
    gate.update([face(0), edge(3)]);
    gate.confirm();
    // Same picks, different order — the preview re-ran after a local pick.
    gate.update([edge(3), face(0)]);
    expect(gate.confirmed).toBe(true);
    // Another foreign pick joined: ask again.
    gate.update([face(0), edge(3), face(1)]);
    expect(gate.pending).toBe(true);
    // One left: ask again too.
    gate.confirm();
    gate.update([face(0)]);
    expect(gate.pending).toBe(true);
    // All gone: nothing to gate.
    gate.update(undefined);
    expect(gate.present).toBe(false);
    expect(gate.blockReason()).toBe(null);
  });

  it('describes what was picked, whose it is and what Apply writes', () => {
    const gate = new ForeignConfirmation();
    gate.update([face(0)]);
    expect(gate.message()).toBe(
      '1 face belongs to part "Bracket". Apply adds expose() there and projects the reference here.',
    );
    gate.update([face(0), edge(1), edge(2)]);
    expect(gate.message()).toBe(
      '1 face and 2 edges belong to part "Bracket". Apply adds expose() there and projects the references here.',
    );
    gate.update([face(0), edge(1, 'Base')]);
    expect(gate.message()).toBe(
      '1 face and 1 edge belong to parts "Bracket" and "Base". Apply adds expose() in each and projects the references here.',
    );
  });

  it('says so when the owner already exposes the geometry', () => {
    const gate = new ForeignConfirmation();
    gate.update([face(0, 'Bracket', { existing: true, exposeName: 'endFace' })]);
    expect(gate.message()).toBe(
      '1 face belongs to part "Bracket", already exposed as endFace. Apply projects the reference here.',
    );
    gate.update([face(0, 'Bracket', { existing: true, exposeName: 'endFace' }), edge(4)]);
    expect(gate.message()).toBe(
      '1 face and 1 edge belong to part "Bracket". Apply exposes what isn\'t yet there and projects the references here.',
    );
  });

  it('reset clears the picks and the confirmation', () => {
    const gate = new ForeignConfirmation();
    gate.update([face(0)]);
    gate.confirm();
    gate.reset();
    expect(gate.present).toBe(false);
    expect(gate.confirmed).toBe(false);
    gate.update([face(0)]);
    expect(gate.pending).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { FeatureMetaSnapshot } from '../src/api';
import { FeatureSchema } from '../src/interactive/create-feature/schema/feature-schema';

// The custom feature dialog is drawn from its metadata snapshot alone: these
// pin the reading — where each row sits (groups, tabs), when it shows, what a
// fresh dialog holds and what a create can't do without.

function meta(params: FeatureMetaSnapshot['params'], extra: Partial<FeatureMetaSnapshot> = {}): FeatureMetaSnapshot {
  return {
    id: 'acme.test',
    label: 'Test',
    group: 'create',
    kind: 'tool',
    operations: [],
    params,
    call: [],
    hasOnChange: false,
    ghost: true,
    contexts: ['part'],
    ...extra,
  };
}

/** The standoff fixture's snapshot, as the catalog serves it. */
const STANDOFF = meta({
  face: { picker: 'face', label: 'On face', surface: 'planar' },
  height: { type: 'length', default: 10, min: 0, label: 'Height' },
  outer: { type: 'length', default: 6, min: 0, label: 'Boss diameter' },
  hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
}, { id: 'acme.standoff', label: 'Standoff', operations: ['add', 'new'] });

/** A vent: tabs, groups and rows that come and go. */
const VENT = meta({
  face: { picker: 'face', label: 'On face' },
  style: {
    type: 'select', label: 'Style', options: [
      { label: 'Slots', value: 'slot' }, { label: 'Holes', value: 'hole' }, { label: 'Hex', value: 6 },
    ],
  },
  count: { type: 'integer', label: 'Count', default: 5, min: 1, max: 40, group: 'Pattern' },
  pitch: { type: 'length', label: 'Pitch', default: 4, group: 'Pattern' },
  width: { type: 'length', label: 'Width', default: 2, visibleWhen: { style: 'slot' } },
  rounded: { type: 'boolean', label: 'Rounded ends', tab: 'Finish', visibleWhen: { style: ['slot', 6] } },
  chamfer: { type: 'length', label: 'Chamfer', optional: true, tab: 'Finish', group: 'Edges' },
  label: { type: 'text', label: 'Label', tab: 'Notes' },
});

describe('FeatureSchema', () => {
  it('lists the typed-in and the picked values in declaration order', () => {
    const schema = new FeatureSchema(STANDOFF);
    expect(schema.names).toEqual(['face', 'height', 'outer', 'hole']);
    expect(schema.pickerNames).toEqual(['face']);
    expect(schema.scalarNames).toEqual(['height', 'outer', 'hole']);
  });

  it('offers the operation tabs in the product order, opening on Add', () => {
    expect(new FeatureSchema(STANDOFF).operations.map(o => o.label)).toEqual(['Add', 'New']);
    expect(new FeatureSchema(STANDOFF).defaultOperation).toBe('add');
    const cutOnly = new FeatureSchema(meta({}, { operations: ['new', 'remove'] }));
    expect(cutOnly.operations.map(o => o.op)).toEqual(['remove', 'new']);
    expect(cutOnly.defaultOperation).toBe('remove');
    expect(new FeatureSchema(meta({})).defaultOperation).toBeNull();
  });

  it('gathers grouped rows under their heading and tabbed rows on their pane', () => {
    const layout = new FeatureSchema(VENT).layout();
    expect(layout.top).toEqual([
      { group: null, names: ['face'] },
      { group: null, names: ['style'] },
      { group: 'Pattern', names: ['count', 'pitch'] },
      { group: null, names: ['width'] },
    ]);
    expect(layout.tabs).toEqual([
      { name: 'Finish', blocks: [{ group: null, names: ['rounded'] }, { group: 'Edges', names: ['chamfer'] }] },
      { name: 'Notes', blocks: [{ group: null, names: ['label'] }] },
    ]);
  });

  it('shows a row while every value its visibleWhen names matches — one value, or any of a list', () => {
    const schema = new FeatureSchema(VENT);
    expect(schema.isVisible('width', { style: 'slot' })).toBe(true);
    expect(schema.isVisible('width', { style: 'hole' })).toBe(false);
    expect(schema.isVisible('rounded', { style: 6 })).toBe(true);
    expect(schema.isVisible('rounded', { style: '6' })).toBe(false);
    expect(schema.isVisible('rounded', { style: 'hole' })).toBe(false);
    expect(schema.isVisible('count', {})).toBe(true);
  });

  it('opens each typed-in row on its default — a select on its first option, a toggle off', () => {
    const schema = new FeatureSchema(VENT);
    expect(schema.defaultOf('count')).toBe(5);
    expect(schema.defaultOf('style')).toBe('slot');
    expect(schema.defaultOf('rounded')).toBe(false);
    expect(schema.defaultOf('chamfer')).toBeUndefined();
    expect(schema.defaultOf('face')).toBeUndefined();
  });

  it('knows what a create cannot leave out', () => {
    const schema = new FeatureSchema(meta({
      face: { picker: 'face', label: 'Face' },
      spare: { picker: 'edge', label: 'Spare', optional: true },
      profile: { picker: 'sketch', label: 'Profile', implicitDefault: true },
      depth: { type: 'length', label: 'Depth' },
      angle: { type: 'angle', label: 'Angle', default: 0 },
      note: { type: 'text', label: 'Note', optional: true },
    }));
    expect(schema.names.filter(name => schema.required(name))).toEqual(['face', 'depth']);
  });

  it('names the required values the dialog cannot pick yet', () => {
    const schema = new FeatureSchema(meta({
      at: { picker: 'connector', label: 'At connector' },
      near: { picker: 'point', label: 'Near', optional: true },
      face: { picker: 'face', label: 'Face' },
    }));
    expect(schema.unpickableRequired()).toEqual(['At connector']);
    expect(FeatureSchema.offersPicker('anchor')).toBe(false);
    expect(FeatureSchema.offersPicker('solid')).toBe(true);
  });

  it("checks a typed-in number the way the engine will, in the value's own words", () => {
    const vent = new FeatureSchema(VENT);
    const count = vent.param('count') as Parameters<typeof FeatureSchema.numberError>[0];
    expect(FeatureSchema.numberError(count, 2.5)).toBe('Count must be a whole number.');
    expect(FeatureSchema.numberError(count, 0)).toBe('Count must be at least 1.');
    expect(FeatureSchema.numberError(count, 41)).toBe('Count must be at most 40.');
    expect(FeatureSchema.numberError(count, 12)).toBeNull();
  });
});

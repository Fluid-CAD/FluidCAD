import { describe, expect, it } from 'vitest';
import type { FeatureMetaSnapshot, FeaturePickerParam } from '../src/api';
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
    defaultOperation: null,
    params,
    call: [],
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
}, { id: 'acme.standoff', label: 'Standoff', operations: ['add', 'new'], defaultOperation: 'add' });

/**
 * A vent: tabs, groups and rows that come and go. Its style and rounded
 * ends declare no default: the engine's snapshot carries the ones they
 * resolve to — the first option, and off.
 */
const VENT = meta({
  face: { picker: 'face', label: 'On face' },
  style: {
    type: 'select', label: 'Style', options: [
      { label: 'Slots', value: 'slot' }, { label: 'Holes', value: 'hole' }, { label: 'Hex', value: 6 },
    ], default: 'slot',
  },
  count: { type: 'integer', label: 'Count', default: 5, min: 1, max: 40, group: 'Pattern' },
  pitch: { type: 'length', label: 'Pitch', default: 4, group: 'Pattern' },
  width: { type: 'length', label: 'Width', default: 2, visibleWhen: { style: 'slot' } },
  rounded: { type: 'boolean', label: 'Rounded ends', default: false, tab: 'Finish', visibleWhen: { style: ['slot', 6] } },
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

  it('offers the operations in the product order, opening on the default the engine names', () => {
    expect(new FeatureSchema(STANDOFF).operations.map(o => o.label)).toEqual(['Add', 'New']);
    expect(new FeatureSchema(STANDOFF).defaultOperation).toBe('add');
    // The engine's rule (Add when offered, else the first listed), not the tabs' order.
    const newFirst = new FeatureSchema(meta({}, { operations: ['new', 'remove'], defaultOperation: 'new' }));
    expect(newFirst.operations.map(o => o.op)).toEqual(['remove', 'new']);
    expect(newFirst.defaultOperation).toBe('new');
    expect(new FeatureSchema(meta({})).defaultOperation).toBeNull();
  });

  it('offers a choice of operations only when there are two or more', () => {
    expect(new FeatureSchema(STANDOFF).offersOperationChoice).toBe(true);
    const cutOnly = new FeatureSchema(meta({}, { operations: ['remove'], defaultOperation: 'remove' }));
    expect(cutOnly.offersOperationChoice).toBe(false);
    expect(cutOnly.defaultOperation).toBe('remove');
    expect(new FeatureSchema(meta({})).offersOperationChoice).toBe(false);
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

  it('opens each typed-in row on the default the engine resolved, and one without any on nothing', () => {
    const schema = new FeatureSchema(VENT);
    expect(schema.defaultOf('count')).toBe(5);
    expect(schema.defaultOf('style')).toBe('slot');
    expect(schema.defaultOf('rounded')).toBe(false);
    expect(schema.defaultOf('chamfer')).toBeUndefined();
    expect(schema.defaultOf('label')).toBeUndefined();
    expect(schema.defaultOf('face')).toBeUndefined();
    // The dialog adds no rule of its own: an optional select without a default opens on nothing.
    const finish = new FeatureSchema(meta({
      finish: { type: 'select', label: 'Finish', optional: true, options: [{ label: 'Matte', value: 'matte' }] },
    }));
    expect(finish.defaultOf('finish')).toBeUndefined();
  });

  it('knows what a create cannot leave out', () => {
    const schema = new FeatureSchema(meta({
      face: { picker: 'face', label: 'Face' },
      spare: { picker: 'edge', label: 'Spare', optional: true },
      profile: { picker: 'sketch', label: 'Profile', implicitDefault: true },
      depth: { type: 'length', label: 'Depth' },
      count: { type: 'integer', label: 'Count', optional: true },
      angle: { type: 'angle', label: 'Angle', default: 0 },
      title: { type: 'text', label: 'Title' },
      note: { type: 'text', label: 'Note', optional: true },
      style: { type: 'select', label: 'Style', options: [{ label: 'Flat', value: 'flat' }], default: 'flat' },
      finish: { type: 'select', label: 'Finish', optional: true, options: [{ label: 'Matte', value: 'matte' }] },
      vented: { type: 'boolean', label: 'Vented', default: false },
    }));
    expect(schema.names.filter(name => schema.required(name))).toEqual(['face', 'depth', 'title']);
  });

  it('reads the kinds a picked value takes, and asks a create for a required location like any pick', () => {
    const schema = new FeatureSchema(meta({
      at: { picker: ['connector', 'point', 'anchor'], multiple: true, label: 'At' },
      pin: { picker: 'connector', label: 'Pin' },
      near: { picker: 'point', label: 'Near', optional: true },
    }));
    expect(FeatureSchema.kindsOf(schema.param('at') as FeaturePickerParam)).toEqual(['connector', 'point', 'anchor']);
    expect(FeatureSchema.kindsOf(schema.param('pin') as FeaturePickerParam)).toEqual(['connector']);
    expect(schema.names.filter(name => schema.required(name))).toEqual(['at', 'pin']);
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

describe("where a feature's declared files are served", () => {
  const meta: FeatureMetaSnapshot = {
    id: 'acme.clip', label: 'Clip', group: 'create', kind: 'tool', operations: ['remove'], defaultOperation: 'remove',
    params: {
      head: { type: 'radio', label: 'Head', default: 'pan', options: [{ label: 'Pan', value: 'pan', image: './clip/pan.svg' }] },
    },
    call: [], ghost: true, contexts: ['part'],
  };

  it('leaves a path as declared with nowhere to serve it from — a built-in declares none', () => {
    expect(new FeatureSchema(meta).assetUrl('./clip/pan.svg')).toBe('./clip/pan.svg');
  });

  it('asks its catalog at every call, so a path resolved after a save is the saved file', () => {
    let revision = 0;
    const schema = new FeatureSchema(meta, { assetUrl: path => `served:${path}@${revision}` });
    expect(schema.assetUrl('./clip/pan.svg')).toBe('served:./clip/pan.svg@0');
    revision = 4;
    expect(schema.assetUrl('./clip/pan.svg')).toBe('served:./clip/pan.svg@4');
  });
});

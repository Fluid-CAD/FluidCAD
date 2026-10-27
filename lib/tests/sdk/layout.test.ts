import { describe, it, expect } from "vitest";
import { getFeatureMeta, listFeatureAssets, registerBuilder, snapshotFeatureMeta } from "../../index.js";
import { Feature, type FeatureMeta } from "../../sdk/index.js";
import type { Shape } from "../../sdk/kernel.js";
import { FeatureLayouts } from "../../sdk/layout.js";
import { defineFastener } from "../fixtures/custom-features/fastener.js";

class BoltCircle extends Feature {
  static id = 'acme.boltCircle';
  buildTool(): Shape[] {
    return [];
  }
}

const SIZES = [{ label: 'M3', value: 'm3' }, { label: 'M4', value: 'm4' }];

/** The bolt circle's values; `patch` adds to a value's spec, by name. */
function values(patch: Record<string, Record<string, unknown>> = {}): Record<string, Record<string, unknown>> {
  const params: Record<string, Record<string, unknown>> = {
    around: { picker: 'axis' },
    count: { type: 'integer', default: 6 },
    start: { type: 'angle', default: 0 },
    size: { type: 'select', default: 'm3', options: SIZES },
    finishes: { type: 'select', multiple: true, default: [], options: SIZES },
    through: { type: 'boolean', default: true },
    depth: { type: 'length', default: 10 },
  };
  for (const [name, more] of Object.entries(patch)) {
    params[name] = { ...params[name], ...more };
  }
  return params;
}

function boltMeta(patch: Record<string, unknown> = {}, params = values()): FeatureMeta {
  const typed = Object.keys(params).filter(name => name !== 'around');
  return {
    class: BoltCircle, label: 'Bolt circle', group: 'create', kind: 'tool', operations: ['remove'],
    params, call: ['around', Object.fromEntries(typed.map(name => [name, name]))],
    ...patch,
  } as unknown as FeatureMeta;
}

function resolved(patch: Record<string, unknown> = {}, params = values()) {
  return getFeatureMeta(registerBuilder(() => () => undefined, { feature: boltMeta(patch, params) }))!;
}

/** The layout with every value placed, less the ones a test places itself. */
function rest(...placed: string[]): string[] {
  return Object.keys(values()).filter(name => !placed.includes(name));
}

function refuses(layout: unknown, message: string, patch: Record<string, unknown> = {}, params = values()) {
  expect(() => resolved({ layout, ...patch }, params)).toThrow(`feature 'acme.boltCircle': ${message}`);
}

describe("a derived layout: what the dialog always built from 'group' and 'tab'", () => {
  const derived = (patch: Record<string, Record<string, unknown>>) => resolved({}, values(patch)).layout;

  it("is the values in order when none has a group or a tab", () => {
    expect(derived({})).toEqual(['around', 'count', 'start', 'size', 'finishes', 'through', 'depth']);
  });

  it("gathers a group in a section where the group first appeared", () => {
    expect(derived({ count: { group: 'Pattern' }, size: { group: 'Hole' }, start: { group: 'Pattern' }, depth: { group: 'Hole' } })).toEqual([
      'around', { section: 'Pattern', items: ['count', 'start'] }, { section: 'Hole', items: ['size', 'depth'] }, 'finishes', 'through',
    ]);
  });

  it("puts the panes in one tabs item after every un-tabbed row, in order of first appearance", () => {
    expect(derived({ count: { tab: 'Pattern' }, size: { tab: 'Hole' }, start: { tab: 'Pattern' }, depth: { tab: 'Hole' } })).toEqual([
      'around', 'finishes', 'through',
      { tabs: [{ label: 'Pattern', items: ['count', 'start'] }, { label: 'Hole', items: ['size', 'depth'] }] },
    ]);
  });

  it("groups within the top level and within each pane: a group above the tabs and again on a pane is two sections", () => {
    expect(derived({
      count: { group: 'Size' }, start: { tab: 'Hole', group: 'Size' }, size: { tab: 'Hole' },
      finishes: { group: 'Size' }, through: { tab: 'Hole', group: 'Size' }, depth: { tab: 'More', group: 'Depth' },
    })).toEqual([
      'around', { section: 'Size', items: ['count', 'finishes'] },
      { tabs: [
        { label: 'Hole', items: [{ section: 'Size', items: ['start', 'through'] }, 'size'] },
        { label: 'More', items: [{ section: 'Depth', items: ['depth'] }] },
      ] },
    ]);
  });

  it("keeps a single tab as a one-tab tabs item, and is frozen", () => {
    const layout = derived({ depth: { tab: 'Hole' }, through: { tab: 'Hole' } });
    expect(layout).toEqual(['around', 'count', 'start', 'size', 'finishes', { tabs: [{ label: 'Hole', items: ['through', 'depth'] }] }]);
    expect(Object.isFrozen(layout)).toBe(true);
    expect(Object.isFrozen((layout[5] as unknown as { tabs: unknown[] }).tabs[0])).toBe(true);
  });
});

describe("an author's layout", () => {
  const LAYOUT = [
    'around',
    { tabs: [
      { label: 'Pattern', items: [{ row: ['count', 'start'], widths: [1, 2] }, { divider: true }] },
      { label: 'Hole', items: [
        { section: 'Size', items: ['size', 'finishes', { image: './dims.svg', alt: 'Sizes', height: 120 }] },
        { section: 'Depth', collapsed: true, visibleWhen: { size: ['m3', 'm4'] }, items: ['through', 'depth'] },
      ] },
    ] },
    { note: 'The holes cut through everything on the axis.', tone: 'warning', visibleWhen: { through: true } },
  ];

  it("is kept as written, checked and deep-frozen", () => {
    const author = JSON.parse(JSON.stringify(LAYOUT));
    const meta = resolved({ layout: author });
    expect(meta.layout).toEqual(LAYOUT);
    expect(meta.layout).not.toBe(author);
    expect(Object.isFrozen(meta.layout)).toBe(true);
    expect(Object.isFrozen((meta.layout[1] as unknown as { tabs: { items: unknown[] }[] }).tabs[1].items[0])).toBe(true);
  });

  it("places every value exactly once, by a declared name", () => {
    refuses(rest('depth'), "the value 'depth' has no place in the layout");
    refuses([...rest(), 'depth'], "the value 'depth' is placed twice in the layout");
    refuses([...rest('count', 'start'), { row: ['count', 'start'] }, { section: 'More', items: ['start'] }], "the value 'start' is placed twice in the layout");
    refuses([...rest(), 'dept'], "layout: names 'dept', which is not one of the feature's values");
    refuses([...rest(), 'toString'], "layout: names 'toString', which is not one of the feature's values");
    refuses([], "'layout' must be a non-empty list, got a list");
    refuses('around', "'layout' must be a non-empty list, got 'around'");
  });

  it("refuses a value's own group or tab: the layout places it", () => {
    refuses(rest(), "param 'size': leave 'group' out — the layout places it", {}, values({ size: { group: 'Hole' } }));
    refuses(rest(), "param 'depth': leave 'tab' out — the layout places it", {}, values({ depth: { tab: 'Hole' } }));
  });

  it("takes an item with exactly one of the item keys, and only that item's fields", () => {
    const keys = 'row, section, tabs, note, image, divider';
    refuses([...rest(), 7], `layout: an item is a value's name or an object with one of ${keys}, got 7`);
    refuses([...rest(), { title: 'Size' }], `layout: an item has exactly one of ${keys}, got { title }`);
    refuses([...rest(), { note: 'Hi', divider: true }], `layout: an item has exactly one of ${keys}, got note and divider`);
    refuses([...rest(), { note: 'Hi', color: 'red' }], "layout: note 'Hi': unknown field 'color' — a note's fields are note, tone, visibleWhen");
    refuses([...rest(), { divider: true, visibleWhen: { through: true } }], "layout: divider: unknown field 'visibleWhen' — a divider's fields are divider");
    refuses([...rest('depth'), { section: 'Depth', items: ['depth'], open: true }], "layout: section 'Depth': unknown field 'open' — a section's fields are section, items, collapsible, collapsed, visibleWhen");
  });

  it("checks a row: 2 to 4 cells, typed-in values and static items, a width per cell", () => {
    refuses([...rest('count'), { row: ['count'] }], "layout: row [count]: a row is a list of 2 to 4 cells, got 1");
    refuses([...rest('count'), { row: 'count' }], "layout: row []: a row is a list of 2 to 4 cells, got 'count'");
    refuses([{ row: ['count', 'start', 'size', 'through', 'depth'] }], "layout: row [count, start, size, through, depth]: a row is a list of 2 to 4 cells, got 5");
    refuses([{ row: ['around', 'count'] }], "layout: row [around, count]: names 'around' — a picked value takes a full row");
    refuses([{ row: ['count', { divider: true }] }], "layout: row [count, divider]: divider can't sit here — a row holds typed-in values, notes and images");
    refuses([{ row: ['count', { row: ['start', 'size'] }] }], "layout: row [count, row]: row [start, size] can't sit here — a row holds typed-in values, notes and images");
    refuses([{ row: ['count', 'start'], widths: [1] }], "layout: row [count, start]: 'widths' must be 2 positive numbers, one per cell, got [1]");
    refuses([{ row: ['count', 'start'], widths: [1, 0] }], "layout: row [count, start]: 'widths' must be 2 positive numbers, one per cell, got [1,0]");
    expect(resolved({ layout: [...rest('count', 'finishes'), { row: ['count', { note: 'each' }, 'finishes', { image: './a.svg' }] }] }).layout).toHaveLength(6);
  });

  it("checks a section: a title, items, no section or tabs inside, 'collapsed' only when it collapses", () => {
    refuses([...rest('depth'), { section: ' ', items: ['depth'] }], "layout: a section's title must be a non-empty string, got ' '");
    refuses([...rest(), { section: 'Depth', items: [] }], "layout: section 'Depth': 'items' must be a non-empty list, got a list");
    refuses([...rest('depth'), { section: 'A', items: [{ section: 'B', items: ['depth'] }] }], "layout: section 'A': section 'B' can't sit here — no section inside a section");
    refuses([...rest('depth'), { section: 'A', items: [{ tabs: [] }] }], "layout: section 'A': 'tabs' sits at the top level of the layout only");
    refuses([...rest('depth'), { section: 'A', items: ['depth'], collapsed: 'yes' }], "layout: section 'A': 'collapsed' must be true or false, got 'yes'");
    refuses([...rest('depth'), { section: 'A', items: ['depth'], collapsed: true, collapsible: false }], "layout: section 'A': 'collapsed: true' needs a section that collapses — leave 'collapsible: false' out");
    expect(() => resolved({ layout: [...rest('depth'), { section: 'A', items: ['depth'], collapsed: false, collapsible: false }] })).not.toThrow();
  });

  it("checks the tabs: top level, once, two or more, distinct labels", () => {
    const tab = (label: unknown, ...items: unknown[]) => ({ label, items });
    refuses([...rest('depth'), { tabs: [tab('A', 'depth')] }], "layout: 'tabs' must be a list of two tabs or more, got 1");
    refuses([...rest('depth', 'size'), { tabs: [tab('A', 'depth'), tab('A', 'size')] }], "layout: tabs: two tabs are labelled 'A'");
    refuses([...rest('depth'), { tabs: [tab('', 'depth'), tab('B', 'size')] }], "layout: tabs: a tab's 'label' must be a non-empty string, got ''");
    refuses([...rest('depth'), { tabs: [tab('A', 'depth'), tab('B')] }], "layout: tab 'B': 'items' must be a non-empty list, got a list");
    refuses([...rest('depth'), { tabs: [{ label: 'A', items: ['depth'], icon: 'x' }, tab('B', 'size')] }], "layout: tab 'A': unknown field 'icon' — a tab's fields are label, items");
    refuses([...rest('depth', 'size', 'count', 'start'), { tabs: [tab('A', 'depth'), tab('B', 'size')] }, { tabs: [tab('C', 'count'), tab('D', 'start')] }], "layout: 'tabs' is given twice — a layout has one set of tabs");
    refuses([...rest('depth', 'size'), { tabs: [tab('A', 'depth'), tab('B', { tabs: [] })] }], "layout: tab 'B': 'tabs' sits at the top level of the layout only");
  });

  it("checks a note, an image and a divider", () => {
    refuses([...rest(), { note: '' }], "layout: 'note' must be a non-empty string, got ''");
    refuses([...rest(), { note: 'Hi', tone: 'loud' }], "layout: note 'Hi': 'tone' must be one of info, warning, got 'loud'");
    refuses([...rest(), { image: '../dims.svg' }], "layout: 'image' must be a relative path inside the module's directory, such as './image.svg', got '../dims.svg'");
    refuses([...rest(), { image: './dims.pdf' }], "layout: 'image' must be an image (.svg, .png, .jpg or .webp), got './dims.pdf'");
    refuses([...rest(), { image: './dims.svg', alt: 3 }], "layout: image './dims.svg': 'alt' must be a string, got 3");
    refuses([...rest(), { image: './dims.svg', height: 8 }], "layout: image './dims.svg': 'height' must be a number of pixels from 16 to 480, got 8");
    refuses([...rest(), { image: './dims.svg', height: '120' }], "layout: image './dims.svg': 'height' must be a number of pixels from 16 to 480, got '120'");
    refuses([...rest(), { divider: false }], "layout: 'divider' must be true, got false");
  });

  it("checks an item's visibleWhen like a value's", () => {
    refuses([...rest('depth'), { section: 'Depth', items: ['depth'], visibleWhen: { thru: true } }], "layout: section 'Depth': 'visibleWhen' names 'thru', which is not one of the feature's values");
    refuses([...rest('count', 'start'), { row: ['count', 'start'], visibleWhen: { around: { surface: 'cylinder' } } }], "layout: row [count, start]: 'visibleWhen': 'around': 'surface' tells picked faces apart, and 'around' picks no faces");
    // An item may hide on a picked value: while nothing is picked for it, here.
    expect(() => resolved({ layout: [...rest('count', 'start'), { row: ['count', 'start'], visibleWhen: { around: { picked: true } } }] })).not.toThrow();
    refuses([...rest(), { note: 'A long note that is cut short here', visibleWhen: { through: 'yes' } }], `layout: note 'A long note that is cut …': 'visibleWhen': "yes" is not a value 'through' can take`);
    refuses([...rest(), { image: './dims.svg', visibleWhen: {} }], "layout: image './dims.svg': 'visibleWhen' must be an object of values to match, such as { style: 'counterbore' }");
    refuses([...rest(), { note: 'Hi', visibleWhen: { finishes: 'm3' } }], "layout: note 'Hi': 'visibleWhen' names 'finishes', a select with 'multiple: true' — it can only name a value that holds one thing");
    // A section may hide on a value it holds: it names no value of its own.
    expect(() => resolved({ layout: [...rest('through'), { section: 'Depth', items: ['through'], visibleWhen: { through: true } }] })).not.toThrow();
  });
});

describe("a dialog's aside and width", () => {
  it("takes static items only in a non-empty aside, with or without a layout", () => {
    const aside = [{ image: './dims.svg', alt: 'Dimensions' }, { divider: true }, { note: 'Sizes in mm.', visibleWhen: { through: true } }];
    expect(resolved({ aside }).aside).toEqual(aside);
    expect(Object.isFrozen(resolved({ aside }).aside)).toBe(true);
    expect(resolved({ aside, layout: rest() }).aside).toEqual(aside);
    const refusesAside = (value: unknown, message: string) => expect(() => resolved({ aside: value })).toThrow(`feature 'acme.boltCircle': ${message}`);
    refusesAside([], "'aside' must be a non-empty list, got a list");
    refusesAside(['depth'], "aside: 'depth' is a value's row — 'aside' holds notes, images and dividers");
    refusesAside([{ row: ['count', 'start'] }], "aside: row [count, start] can't sit here — 'aside' holds notes, images and dividers");
    refusesAside([{ section: 'More', items: [{ note: 'x' }] }], "aside: section 'More' can't sit here — 'aside' holds notes, images and dividers");
    refusesAside([{ tabs: [] }], "aside: 'tabs' sits at the top level of the layout only");
    refusesAside([{ image: 'https://example.com/a.svg' }], "aside: 'image' must be a relative path inside the module's directory");
    refusesAside([{ note: 'x', visibleWhen: { thru: true } }], "aside: note 'x': 'visibleWhen' names 'thru', which is not one of the feature's values");
  });

  it("takes a value's own aside — static items only, its images checked — for the card while the value has the focus", () => {
    const depthAside = [{ image: './depth.svg', alt: 'Depth from the face' }, { note: 'Blind only.', visibleWhen: { through: false } }];
    const meta = resolved({}, values({ depth: { aside: depthAside } }));
    expect(meta.params.depth.aside).toEqual(depthAside);
    expect(Object.isFrozen(meta.params.depth.aside)).toBe(true);
    expect(snapshotFeatureMeta(meta).params.depth.aside).toEqual(depthAside);
    expect(resolved({}, values({ around: { aside: [{ note: 'The axis the holes circle.' }] } })).params.around.aside)
      .toEqual([{ note: 'The axis the holes circle.' }]);
    const refusesValueAside = (value: unknown, message: string) =>
      expect(() => resolved({}, values({ depth: { aside: value } }))).toThrow(`feature 'acme.boltCircle': ${message}`);
    refusesValueAside([], "param 'depth': 'aside' must be a non-empty list, got a list");
    refusesValueAside(['count'], "param 'depth': aside: 'count' is a value's row — 'aside' holds notes, images and dividers");
    refusesValueAside([{ image: '../out.svg' }], "param 'depth': aside: 'image' must be a relative path inside the module's directory");
    refusesValueAside([{ note: 'x', visibleWhen: { thru: true } }], "param 'depth': aside: note 'x': 'visibleWhen' names 'thru', which is not one of the feature's values");
  });

  it("takes 'wide' or 'wider' for the width", () => {
    expect(resolved({ width: 'wide' }).width).toBe('wide');
    expect(resolved({ width: 'wider' }).width).toBe('wider');
    expect('width' in resolved()).toBe(false);
    expect(() => resolved({ width: 'huge' })).toThrow("feature 'acme.boltCircle': 'width' must be one of wide, wider, got 'huge'");
    expect(() => resolved({ width: 640 })).toThrow("'width' must be one of wide, wider, got 640");
  });
});

describe("the snapshot and the assets of a layout", () => {
  it("always carries the layout — derived or as written — and width and aside only when declared", () => {
    const bare = snapshotFeatureMeta(resolved({}, values({ depth: { group: 'Depth' } })));
    expect(bare.layout).toEqual(['around', 'count', 'start', 'size', 'finishes', 'through', { section: 'Depth', items: ['depth'] }]);
    expect('width' in bare).toBe(false);
    expect('aside' in bare).toBe(false);

    const layout = [...rest('count', 'start'), { row: ['count', 'start'] }, { divider: true }];
    const aside = [{ image: './dims.svg' }];
    const full = snapshotFeatureMeta(resolved({ layout, width: 'wide', aside }));
    expect(full.layout).toEqual(layout);
    expect(full.width).toBe('wide');
    expect(full.aside).toEqual(aside);
    expect(JSON.parse(JSON.stringify(full))).toEqual(full);
    expect(Object.isFrozen(full.layout)).toBe(false);

    // Metadata nobody checked yet reads the same.
    expect(snapshotFeatureMeta(boltMeta({}, values({ depth: { tab: 'Hole' } }))).layout)
      .toEqual(['around', 'count', 'start', 'size', 'finishes', 'through', { tabs: [{ label: 'Hole', items: ['depth'] }] }]);
  });

  it("carries the fastener fixture's layout and aside", () => {
    const snapshot = snapshotFeatureMeta(defineFastener().meta);
    expect(snapshot.layout).toEqual([
      'at', 'standard', 'size', 'head',
      { note: 'The recess is sized for the head of the screw.', visibleWhen: { head: ['counterbore', 'countersink'] } },
      'depth',
      { image: './fastener/depth.svg', alt: 'The depth, measured from the surface', height: 64 },
      { section: 'Finish', collapsed: true, items: [{ row: ['marking', 'finishes'] }] },
    ]);
    expect(snapshot.aside).toEqual([{ image: './fastener/section.svg', alt: 'A section through the hole' }]);
    expect('width' in snapshot).toBe(false);
  });

  it("lists the layout's images, then the aside's and the values' asides', after the icon and the options' — each once", () => {
    const layout = [
      ...rest('count', 'depth'),
      { row: ['count', { image: './row.svg' }] },
      { section: 'Depth', items: ['depth', { image: './section.png' }] },
      { image: './top.svg' },
    ];
    const aside = [{ image: './aside.svg' }, { image: './top.svg' }, { image: './icon.svg' }];
    const params = values({ start: { aside: [{ image: './start.svg' }, { image: './aside.svg' }] } });
    const meta = resolved({ icon: './icon.svg', layout, aside }, params);
    const assets = ['./icon.svg', './row.svg', './section.png', './top.svg', './aside.svg', './start.svg'];
    expect(listFeatureAssets(meta)).toEqual(assets);
    expect(listFeatureAssets(snapshotFeatureMeta(meta))).toEqual(assets);
    expect(FeatureLayouts.images(undefined)).toEqual([]);
  });
});

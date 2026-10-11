---
id: api/feature-layout
title: "layout, width, aside — laying out a custom feature's dialog"
summary: "defineFeature()'s optional layout is a tree of items that places every value's row exactly once: a value's name, { row: [...] } of 2–4 typed-in cells, { section: 'Title', items } (collapsible, collapsed), { tabs: [{ label, items }] } at the top level, and the static items { note }, { image }, { divider: true }. width is 'wide' or 'wider'; aside is a list of static items beside the rows. Left out, the layout is derived from the values' group and tab. Items take visibleWhen. Presentation only: it never changes the statement written."
tags: [api, sdk, custom-feature, metadata, dialog, layout, type]
symbols: [FeatureLayout, FeatureLayoutItem, FeatureLayoutRow, FeatureLayoutSection, FeatureLayoutTabs, FeatureLayoutTab, FeatureLayoutNote, FeatureLayoutImage, FeatureLayoutDivider, FeatureStaticItem, FeatureDialogWidth]
seeAlso: [api/define-feature, api/feature-params, concepts/custom-features]
---

# Dialog layout

Three optional fields of [`defineFeature()`](define-feature.md)'s metadata
(and of the whole metadata `registerBuilder` takes), imported with it from
`fluidcad/sdk`:

```ts
layout?: FeatureLayout;          // the rows, top to bottom — every value placed exactly once
width?: 'wide' | 'wider';        // how wide the dialog opens; the default width when left out
aside?: FeatureStaticItem[];     // notes, images and dividers shown beside the rows
```

They are presentation only: two features that differ in nothing else write
the same statement, and a hand-written call is checked the same way.

## Items

| Item | Fields | Rules |
|---|---|---|
| `'name'` | — | A declared value's row. |
| `{ row: [...] }` | `widths?: number[]`, `visibleWhen?` | 2 to 4 cells side by side. A cell is a typed-in value's name, a `note` or an `image`; a picked value is refused ("a picked value takes a full row"). `widths` are positive numbers, one per cell: the cells' relative widths. |
| `{ section: 'Title', items: [...] }` | `collapsible?: boolean`, `collapsed?: boolean`, `visibleWhen?` | Rows under a heading: names, rows and static items — no section inside a section, no tabs. `collapsed: true` opens it folded and makes it collapsible; with `collapsible: false` it is refused. |
| `{ tabs: [{ label, items }] }` | — | At the top level only, at most once; two tabs or more, with distinct labels. A tab's items are names, rows, sections and static items. |
| `{ note: 'text' }` | `tone?: 'info' \| 'warning'`, `visibleWhen?` | A line of text. |
| `{ image: './x.svg' }` | `alt?: string`, `height?: number`, `visibleWhen?` | A picture next to the module, by relative path, like `icon` and an option's `image` (`.svg`, `.png`, `.jpg`, `.webp`). Shown as a picture, so `currentColor` in an SVG draws black: pick colours that read on both themes ([feature-params](feature-params.md), Options). `height` is in pixels, 16 to 480. |
| `{ divider: true }` | — | A rule between rows. |

An item object has exactly one of `row`, `section`, `tabs`, `note`, `image`,
`divider`. An unknown field is refused by name, with the fields that item
takes. `note`, `image` and `divider` are the static items: they show no value.

## Rules

- **Every value is placed exactly once.** A value left out is refused
  ("the value 'depth' has no place in the layout"), as is one placed twice
  and a name that is not one of the feature's values.
- **The layout places the rows, so a value's own `group` or `tab` is
  refused** beside it: "param 'size': leave 'group' out — the layout places it".
- **`visibleWhen` on an item** reads like a value's (see
  [feature-params](feature-params.md)): an object of typed-in values to
  match, each a value or a list of values. It may not name a picked value or
  a select with `multiple: true`. A value's own `visibleWhen` still hides its
  row wherever the layout puts it.
- **`aside`** is a non-empty list of static items only, with or without a
  `layout`. A value may declare an `aside` of its own (below).
- **`width`** is `'wide'` or `'wider'`.
- Under `defineFeature()` the names are typed from the class's values: a
  misspelled one is an error in the editor.

## Without a layout

A feature that declares none gets the layout its values' `group` and `tab`
describe — the short form, kept for simple dialogs:

- values in declaration order;
- a value with a `tab` sits on that tab's pane; the panes are in order of
  first appearance, gathered in one `tabs` item after every row without a tab
  (a single tab is still shown as tabs);
- at the top level and on each pane, a value with a `group` joins the section
  its group got where the group first appeared there; a value without one
  stands alone.

## Example

A bolt circle on a wide dialog: the axis on top, two tabs, a row of two
values, a section that opens folded, a note shown only for through holes and
a dimension picture beside the rows.

```feature.js
// bolt-circle.feature.js
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Vector3d } from 'fluidcad/math';

/** Clearance holes for metric screws (ISO 273, normal fit). */
const CLEARANCE = { m3: 3.4, m4: 4.5, m5: 5.5 };

/** Long enough to cut through anything a bolt circle is put on. */
const THROUGH = 1000;

export class BoltCircle extends Feature.with({
  around: { picker: 'axis', label: 'Around axis' },
  count: { type: 'integer', label: 'Holes', default: 4, min: 1, max: 36 },
  circle: { type: 'length', label: 'Circle diameter', default: 32, min: 0 },
  start: { type: 'angle', label: 'Start angle', default: 45 },
  size: {
    type: 'select',
    label: 'Screw',
    default: 'm3',
    options: [
      { label: 'M3 (3.4 mm)', value: 'm3' },
      { label: 'M4 (4.5 mm)', value: 'm4' },
      { label: 'M5 (5.5 mm)', value: 'm5' },
      { label: 'Custom', value: 'custom' },
    ],
  },
  diameter: { type: 'length', label: 'Hole diameter', default: 3, min: 0, visibleWhen: { size: 'custom' } },
  through: { type: 'boolean', label: 'Through all', default: true },
  depth: { type: 'length', label: 'Depth', default: 3, min: 0, visibleWhen: { through: false } },
}) {
  static id = 'boltCircle';

  buildTool() {
    const { count, circle, start, size, diameter, through, depth } = this.values;
    const hole = size === 'custom' ? diameter : CLEARANCE[size];
    const around = this.axisOf(this.values.around);
    const z = around.direction.normalize();
    const helper = Math.abs(z.z) < 0.9 ? new Vector3d(0, 0, 1) : new Vector3d(1, 0, 0);
    const x = helper.cross(z).normalize();
    const y = z.cross(x);
    const length = through ? 2 * THROUGH : depth;
    const back = through ? -THROUGH : 0;

    const tools = [];
    for (let i = 0; i < count; i++) {
      const angle = (start + (360 * i) / count) * Math.PI / 180;
      const offset = x.multiply(Math.cos(angle) * circle / 2)
        .add(y.multiply(Math.sin(angle) * circle / 2))
        .add(z.multiply(back));
      const cylinder = Primitives.makeCylinder(hole / 2, length);
      tools.push(ShapeOps.transform(cylinder, Matrix4.fromBasis(x, y, z, around.origin.add(offset))));
      cylinder.dispose();
    }
    return tools;
  }
}

export const boltCircle = defineFeature(BoltCircle, {
  label: 'Bolt circle',
  group: 'create',
  operations: ['remove'],
  call: ['around', { count: 'count', circle: 'circle', start: 'start', size: 'size', diameter: 'diameter', through: 'through', depth: 'depth' }],
  width: 'wide',
  layout: [
    'around',
    { tabs: [
      { label: 'Pattern', items: [{ row: ['count', 'start'] }, 'circle'] },
      { label: 'Hole', items: [
        { section: 'Size', items: ['size', 'diameter'] },
        { section: 'Depth', collapsed: true, items: ['through', 'depth'] },
      ] },
    ] },
    { note: 'The holes cut through everything on the axis.', visibleWhen: { through: true } },
    { divider: true },
  ],
  aside: [{ image: './bolt-circle-dims.svg', alt: 'Circle diameter and start angle' }],
});
```

A dialog with every control, a row of two cells, a folded section and an
aside is the [screw hole](feature-params.md#example-a-screw-hole-with-choices).

## A value's own aside

A value may declare `aside` beside its `label` and `hint`: the same list of
static items, shown on the card beside the dialog **in place of** the
feature's `aside` while that value's row holds the focus or the pointer
rests on it (a pointer only passing over swaps nothing). Focus on a row
without one brings the feature's back. Use it for a diagram of what the
value measures, and a note on what the diagram labels:

```js
const sizeAside = [
  { image: './img/aside-size.png', alt: 'The circular pitch p = π · m', height: 200 },
  { note: 'Module m is p / π; diametral pitch P is 25.4 / m.' },
];

export class Gear extends Feature.with({
  sizeBy: { type: 'select', default: 'module', options: [/* … */], aside: sizeAside },
  module: { type: 'select', default: 2, options: [/* … */], aside: sizeAside, visibleWhen: { sizeBy: 'module' } },
  // …
}) { /* … */ }
```

- The items take `visibleWhen`; a value whose aside shows nothing at the
  moment keeps the feature's on the card.
- A value's aside needs no feature `aside`: the card appears when one shows.
- The card is the wide-window one. Where the dialog is a sheet (a narrow
  window) only the feature's `aside` shows, at the top of the body.
- Its images are assets of the feature, served like the others.

The card is 200 px wide inside: an image drawn square at 320 px and shown
with `height: 200` fills it, and the card keeps its size as it swaps.

## How a row of cells fits

A row's cells share its width by their `widths`, and none is squeezed below
what its content needs whole: a segmented choice's labels, a select's longest
option, an image card's label, a stepper's number. A cell that doesn't fit
beside the others moves onto a line of its own, full width; a cell whose
value hides leaves the row to the cells that show. Inside the full width, a
`buttons` choice wraps its labels and `cards` drop columns rather than cut a
label short. So a row never truncates — but a cell that wraps reads as a
row of its own: pair values whose controls are narrow (numbers, short
selects), and give a long segmented choice a line to itself.

## The snapshot

The metadata's snapshot — what the editor's catalog sends the dialog —
always carries `layout`: the declared one as written, or the derived one.
`width` and `aside` are there only when declared, and a value's own `aside`
sits on its spec. Every `image` of the layout, of the aside and of a value's
aside is one of the feature's assets, served like its icon.

---
id: api/feature-params
title: "ParamSpec — a custom feature's values: typed-in values and pickers"
summary: "Each value a custom feature declares in Feature.with({ … }) is typed in ({ type: 'number' | 'integer' | 'length' | 'angle' | 'boolean' | 'select' | 'text', default, min, max }) or picked ({ picker: 'sketch' | 'face' | 'edge' | 'axis' | 'plane' | 'solid' | 'feature' | 'connector' | 'point' | 'anchor' }, a list with multiple/max), with label, description, group, tab, visibleWhen and optional for the dialog. picker: [kinds] is a union whose kinds must take different clicks. An axis picker always takes connectors. tangents, connector on an axis, and a picker's default are refused by name."
tags: [api, sdk, custom-feature, type]
symbols: [ParamSpec, PickerKind, VisibleWhen]
seeAlso: [api/feature, api/define-feature, concepts/custom-features, api/connector, api/axis, api/face-filter, api/edge-filter]
---

# ParamSpec

Imported (as types) from `fluidcad/sdk`. Declared in `Feature.with({ … })`,
one entry per value, in dialog order.

```ts
type ParamSpec = ScalarParamSpec | PickerParamSpec;

// Every value
{ label?: string; description?: string; group?: string; tab?: string;
  visibleWhen?: { [typedInValue: string]: scalar | scalar[] }; optional?: boolean }

// Typed in
{ type: 'number' | 'integer' | 'length' | 'angle'; default?: number; min?: number; max?: number; step?: number }
{ type: 'boolean'; default?: boolean }
{ type: 'select'; options: { label: string; value: string | number }[]; default?: string | number }
{ type: 'text'; default?: string }

// Picked — no default; a list with multiple: true or max: n (n ≥ 2); ordered: true for a list whose order matters
{ picker: 'sketch'; implicitDefault?: boolean; hasGeometry?: boolean; wire?: boolean }
{ picker: 'face'; surface?: 'planar' | 'cylinder' | 'cone' | 'torus'; sameFile?: boolean }
{ picker: 'edge'; curve?: 'line' | 'circle' | 'arc'; facesAsEdges?: boolean }
{ picker: 'axis' }                      // one only; takes connectors too
{ picker: 'plane' }                     // one only
{ picker: 'solid' }
{ picker: 'feature'; types?: string[] }
{ picker: 'connector' }
{ picker: 'point' }
{ picker: 'anchor'; anchors?: ('center' | 'start' | 'end' | 'offset')[] }
{ picker: PickerKind[]; …each kind's own fields }   // a union
```

## What every value declares

| Field | Meaning |
|---|---|
| `label` | The dialog row's label. Left out, the name made readable: `holeDiameter` → "Hole diameter". |
| `description` | The row's tooltip. |
| `group` | A heading over the rows that share it; a grouped row joins its group where the group first appears. |
| `tab` | The dialog tab the row sits on. Rows without a tab sit above the tabs; tabs appear in first-appearance order. |
| `visibleWhen` | When the row shows: every named value must equal the given one, or one of a listed set — `{ through: false }`, `{ size: ['m3', 'm4'] }`. It names typed-in values only. A hidden row writes nothing in a create. |
| `optional` | The call may leave the value out. Without a `default` it then reaches the feature as `undefined`. |

## Typed-in values

| `type` | Value | Notes |
|---|---|---|
| `number` | `number` | |
| `integer` | `number` | a whole number |
| `length` | `number` | in the model file's unit; a default is a plain number in that unit and does not scale with `unit()` |
| `angle` | `number` | degrees |
| `boolean` | `boolean` | a toggle |
| `select` | the union of its options' values | `options: [{ label: 'M3 (3.4 mm)', value: 'm3' }, …]`; values are strings or numbers |
| `text` | `string` | |

Give a `select` and a `boolean` a `default` (or make them `optional`):
without one the dialog shows the first option, or the toggle off, but a
create that leaves the row untouched writes nothing, and the builder requires
the value.

The builder checks every value it is called with, so a model that passes a
wrong one fails to compile at that call: `boltCircle(): 'count' must be at
least 1, got 0`, `boltCircle(): 'size' must be one of "m3", "m4", "m5",
"custom", got 'm6'`, `boltCircle(): 'count' must be a whole number, got 2.5`.
A value left out (or `null`) takes its `default`; one with neither a default
nor `optional` is required: `standoff(): 'face' is required`.

The dialog's number rows take expressions and model variables
(`param()` values included), as the built-in dialogs do. A create writes
only the values the user changed; the others stay the builder's defaults.

## Picked values

Every scene-object value is picked in the viewport or the timeline. What the
dialog writes is the expression a model would write by hand.

| `picker` | The dialog takes | It writes | Read with |
|---|---|---|---|
| `sketch` | a sketch's wire, or its timeline row; `wire: true` also a helix and other wire sources | the sketch's variable | `shapesOf()` |
| `face` | faces | `e.endFaces()`, `select(face()…)` | `facesOf()` |
| `edge` | edges; with `facesAsEdges: true` a face stands for its edges | `e.endEdges(0)`, `select(edge()…)` | `edgesOf()` |
| `axis` | a world axis, an `axis()` line or row, a straight edge, a connector's gizmo or row | `'z'`, `ax`, `axis(e.sideEdges(0))`, `bolt`, `bolt.instance(1)` | `axisOf()` |
| `plane` | an origin plane, a `plane()` quad or row, a planar face | `'xy'`, `p`, `plane(e.endFaces())` | `planeOf()` |
| `solid` | a face or edge of a solid, or a feature row: the statement that made it | that statement's variable | `shapesOf()` |
| `feature` | a feature row in the timeline | its variable | `shapesOf()` |
| `connector` | a connector's gizmo or row, or a copy's | `bolt`, `bolt.instance(2)` | `frameOf()`, `pointOf()` |
| `point` | a vertex: a sketch point, a solid's corner | `s.geometries.a` (the sketch returns it), `e.endEdges(0).end()` | `frameOf()`, `pointOf()` |
| `anchor` | a face or an edge, then one of its suggested anchors | `e.endFaces().center()`, `e.sideEdges(0).start()` | `frameOf()`, `pointOf()` |

A model's own call may also hand an axis value a world axis name (`'z'`) or
an `Axis`, and a plane value an origin plane name (`'xy'`, `'front'`) or a
`Plane`; the builder turns each into the axis or plane statement it stands
for, with no timeline row of its own.

Options:

- **Lists.** `multiple: true`, or `max: n` (a whole number, 2 or more; it
  makes the value a list). A list is always a list: one scene object passed
  for it becomes a list of one, and left out it is `[]`. `ordered: true` lets
  the dialog reorder the picks by dragging. `axis` and `plane` pick one thing
  and take no list fields.
- **`surface` / `curve`** limit what the dialog takes, checked by the engine
  on the pick: "On face: the picked face is not planar — this value takes
  faces that match face().planar()". A call written by hand is not checked:
  check in `buildTool()` when it matters.
- **`implicitDefault: true`** (one sketch): the call may leave the sketch out.
  The dialog then writes none, and the value reaches the feature as
  `undefined`.
- **`hasGeometry: true`**: the dialog refuses a sketch with nothing drawn in
  it.
- **`types`** (`feature`): the feature types or ids the dialog takes.
- **`anchors`** (`anchor`): the anchors the dialog suggests on a face or an
  edge; all of them when left out. A point value can't refuse an edge's
  `.start()`, which is a point too.
- **`sameFile`** (`face`): accepted; the dialog doesn't read it yet.

## Unions: `picker: [kinds]`

A value that takes more than one kind of pick lists them:
`{ picker: ['connector', 'point', 'anchor'], multiple: true }` places a
feature at connectors, points and anchors alike; `['solid', 'connector']`
takes either. Each click is routed to the one kind that takes it, so **the
kinds must take different clicks**:

| Kind | Takes |
|---|---|
| `sketch` | a sketch wire, a sketch row |
| `face` | a face |
| `edge` | an edge (and a face with `facesAsEdges`) |
| `axis` | an edge, an axis line, a world axis, an axis row, a connector, a connector row |
| `plane` | a face, a plane quad, an origin plane, a plane row |
| `solid` | a face, an edge, a feature row |
| `feature` | a feature row |
| `connector` | a connector, a connector row |
| `point` | a vertex |
| `anchor` | a face, an edge |

`['connector', 'point', 'anchor']`, `['solid', 'connector']` and
`['face', 'edge']` pass. `['face', 'anchor']` is refused: "both 'face' and
'anchor' take a face click — a picker of several kinds routes each click to
the one kind that takes it; leave one out, or declare two values".
`['solid', 'feature']` and `['edge', 'face']` with `facesAsEdges` clash the
same way.

A union lists at least two distinct kinds, carries each kind's own fields,
takes list fields only when every kind can be a list, and refuses
`implicitDefault`. Its elements are told apart in the feature with
`isLocation()` (see [[api/feature]]).

## Fields refused by name

A misspelled field is refused where the module loads ("unknown field
'defualt' for a length value — its fields are …"). These are refused by
name, with the reason:

| Field | Message |
|---|---|
| `tangents` on an edge picker | `leave 'tangents' out — tangent chains are for fillet and chamfer only` |
| `connector` on an axis picker | `leave 'connector' out — an axis picker always takes connectors` |
| `'connector'` beside `'axis'` in a union | `an axis picker already takes connectors (a connector's Z axis) — leave 'connector' out of the list` |
| `default` on any picker | `a picker takes no default — its value is what the user picks` |

Fields refused on the feature itself (`illustration`, `onChange`, `id`,
`defaultOperation`) are listed in [[api/define-feature]].

## Example: a bolt circle

An axis picker (a world axis, an axis, a straight edge or a connector), a
whole number, a length, an angle, a choice, a toggle, rows shown only for
some choices, groups and tabs. It only cuts, so `remove` is its default
operation and its dialog shows no operation tabs.

```feature.js
// bolt-circle.feature.js
// A ring of clearance holes around an axis, cut through the part: the
// mounting pattern of a fan, a flange or a round connector.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Vector3d } from 'fluidcad/math';

/** Clearance holes for metric screws (ISO 273, normal fit). */
const CLEARANCE = { m3: 3.4, m4: 4.5, m5: 5.5 };

/** Long enough to cut through anything a bolt circle is put on. */
const THROUGH = 1000;

export class BoltCircle extends Feature.with({
  around: { picker: 'axis', label: 'Around axis' },
  count: { type: 'integer', label: 'Holes', default: 4, min: 1, max: 36, tab: 'Pattern' },
  circle: { type: 'length', label: 'Circle diameter', default: 32, min: 0, tab: 'Pattern' },
  start: { type: 'angle', label: 'Start angle', default: 45, tab: 'Pattern' },
  size: {
    type: 'select',
    label: 'Screw',
    tab: 'Hole',
    group: 'Size',
    default: 'm3',
    options: [
      { label: 'M3 (3.4 mm)', value: 'm3' },
      { label: 'M4 (4.5 mm)', value: 'm4' },
      { label: 'M5 (5.5 mm)', value: 'm5' },
      { label: 'Custom', value: 'custom' },
    ],
  },
  diameter: { type: 'length', label: 'Hole diameter', default: 3, min: 0, tab: 'Hole', group: 'Size', visibleWhen: { size: 'custom' } },
  through: { type: 'boolean', label: 'Through all', default: true, tab: 'Hole', group: 'Depth' },
  depth: { type: 'length', label: 'Depth', default: 3, min: 0, tab: 'Hole', group: 'Depth', visibleWhen: { through: false } },
}) {
  static id = 'acme.boltCircle';

  buildTool() {
    const { count, circle, start, size, diameter, through, depth } = this.values;
    const hole = size === 'custom' ? diameter : CLEARANCE[size];
    if (!(hole > 0) || !(hole < circle)) {
      throw new Error(`bolt circle: the holes (${hole}) must be narrower than the circle (${circle})`);
    }
    const around = this.axisOf(this.values.around);
    const z = around.direction.normalize();
    const helper = Math.abs(z.z) < 0.9 ? new Vector3d(0, 0, 1) : new Vector3d(1, 0, 0);
    const x = helper.cross(z).normalize();
    const y = z.cross(x);
    // Through all reaches both ways along the axis; a depth goes along it from its origin.
    const length = through ? 2 * THROUGH : depth;
    const back = through ? -THROUGH : 0;

    // One cylinder per hole, placed around the axis: one statement, one row.
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
  description: 'A ring of clearance holes around an axis',
  group: 'create',
  // It only cuts: remove is its default, so boltCircle('z') cuts without a
  // .remove() chain, and its dialog shows no operation tabs.
  operations: ['remove'],
  call: ['around', { count: 'count', circle: 'circle', start: 'start', size: 'size', diameter: 'diameter', through: 'through', depth: 'depth' }],
});
```

A mounting plate for a 40 mm fan: its four M3 holes sit on a 32 mm square,
which is a Ø45.25 circle at 45°.

```fluid.js
import { part, sketch, line, extrude } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";
import { boltCircle } from "./bolt-circle.feature.js";

export const fanPlate = part("Fan plate", () => {
  sketch("xy", () => {
    const b = line([-26, -24], [24, -26]);
    const r = line([24, -26], [26, 24]);
    const t = line([26, 24], [-24, 26]);
    const l = line([-24, 26], [-26, -24]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-25, -25]);
    distance(b.start(), b.end(), 50);
    distance(r.start(), r.end(), 50);
  });
  extrude(3);

  boltCircle("z", { circle: 45.25 });
});
```

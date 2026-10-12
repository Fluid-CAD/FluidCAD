---
id: api/feature-params
title: "ParamSpec — a custom feature's values: typed-in values and pickers"
summary: "Each value a custom feature declares in Feature.with({ … }) is typed in (type: 'number' | 'integer' | 'length' | 'angle' | 'boolean' | 'select' | 'radio' | 'text'; a select with multiple: true is a list) or picked (picker: 'sketch' | 'face' | 'edge' | 'axis' | 'plane' | 'solid' | 'feature' | 'connector' | 'point' | 'anchor', or a union of kinds). How a row looks is separate from what the value is: display (slider, stepper, checkbox, grid, buttons, cards), suffix, hint, an option's image and description, and when on an option, which narrows what the dialog offers by another value. One table gives what an untouched row shows, what the builder gets for a value left out, and whether an empty row blocks Apply."
tags: [api, sdk, custom-feature, type]
symbols: [ParamSpec, ScalarParamSpec, NumberParamSpec, BooleanParamSpec, SelectParamSpec, RadioParamSpec, TextParamSpec, ChoiceOption, PickerParamSpec, PickerKind, VisibleWhen, PickCondition, PickedSurface, OptionWhen]
seeAlso: [api/feature, api/define-feature, api/feature-layout, concepts/custom-features, api/connector, api/axis, api/face-filter, api/edge-filter]
---

# ParamSpec

Imported (as types) from `fluidcad/sdk`. Declared in `Feature.with({ … })`,
one entry per value, in dialog order.

```ts
type ParamSpec = ScalarParamSpec | PickerParamSpec;

// Every value
{ label?: string; description?: string; hint?: string; aside?: FeatureStaticItem[]; group?: string; tab?: string;
  visibleWhen?: { [typedInValue: string]: scalar | scalar[] }; optional?: boolean }

// Typed in — NumberParamSpec, BooleanParamSpec, SelectParamSpec, RadioParamSpec, TextParamSpec
{ type: 'number' | 'integer' | 'length' | 'angle'; default?: number; min?: number; max?: number; step?: number;
  display?: 'slider' | 'stepper'; suffix?: string }
{ type: 'boolean'; default?: boolean; display?: 'checkbox' }   // no default: false
{ type: 'select'; options: ChoiceOption[]; default?: string | number;
  display?: 'list' | 'grid'; columns?: number; search?: boolean }
{ type: 'radio'; options: ChoiceOption[]; default?: string | number;
  display?: 'list' | 'inline' | 'buttons' | 'cards'; columns?: number }
                                                           // both, no default: the first option offered; unset when optional
{ type: 'select'; multiple: true; options: ChoiceOption[]; default?: (string | number)[]; min?: number; max?: number;
  display?: 'list' | 'grid'; columns?: number; search?: boolean }   // a list; no default: []
{ type: 'text'; default?: string; multiline?: boolean; placeholder?: string; maxLength?: number; pattern?: string }
// ChoiceOption — one option of a select or a radio; only `value` reaches the feature
{ label: string; value: string | number; image?: string; description?: string; group?: string; keywords?: string[]; when?: { [otherValue: string]: scalar | scalar[] } }

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
| `group` | A heading over the rows that share it; a grouped row joins its group where the group first appears. The short form of a `section` in a [layout](feature-layout.md): refused when the feature declares a `layout`, which places the rows itself. |
| `tab` | The dialog tab the row sits on. Rows without a tab sit above the tabs; tabs appear in first-appearance order. The short form of `tabs` in a [layout](feature-layout.md): refused when the feature declares a `layout`. |
| `visibleWhen` | When the row shows: every named typed-in value must equal the given one, or one of a listed set — `{ through: false }`, `{ size: ['m3', 'm4'] }` — and every named picked value must meet its condition (below). A hidden row writes nothing in a create. |
| `optional` | The call may leave the value out. Without a `default` it then reaches the feature as `undefined` — except a boolean, which is always `false` or `true`. |

### Rows that follow a pick: a picked value in `visibleWhen`

A `visibleWhen` (a value's, or a [layout](feature-layout.md) item's) may name
a picked value with a condition on what it holds — every field given must
hold:

| Field | Holds when |
|---|---|
| `picked: true` / `false` | the value holds a pick / nothing |
| `surface: 'cylinder'` (or a list) | the value holds picks and each is a face of that surface: `'planar'`, `'cylinder'`, `'cone'`, `'sphere'`, `'torus'` or `'other'`. Only for a value that takes faces. |
| `not: { … }` | the condition given does not hold |

```js
at: { picker: ['face', 'axis'], optional: true },
// The hub's rows go while a shaft (a cylindrical face) is picked: nothing
// picked, an axis or a planar face keep them.
hubDiameter: { type: 'length', default: 20, visibleWhen: { at: { not: { surface: 'cylinder' } } } },
```

- The dialog classifies a picked face when it is picked, and the rows follow
  each pick, its removal, and an edit's kept selection once it resolves. A
  face not classified yet meets no `surface`, so a row hidden on one shows
  for a moment until it is.
- An edge, an axis, a statement or a connector is a pick but no face: it
  counts for `picked`, never for `surface`.
- Only `visibleWhen` reads picks: an option's `when` names typed-in values
  only. Like any `visibleWhen`, it hides rows and writes nothing for them in
  a create; it doesn't change what a call written by hand passes, so a
  feature still reads its picks in `buildTool()` (a hub's values reach it
  whatever was picked).
- Refused by name: a condition that isn't an object (`{ at: 'shaft' }` —
  "give it a condition such as { picked: true } or { surface: 'cylinder' }"),
  a `surface` on a value that picks no faces, an unknown surface or field.

## Typed-in values

| `type` | Value | Notes |
|---|---|---|
| `number` | `number` | |
| `integer` | `number` | a whole number |
| `length` | `number` | in the model file's unit; a default is a plain number in that unit and does not scale with `unit()` |
| `angle` | `number` | degrees |
| `boolean` | `boolean` | a toggle |
| `select` | the union of its options' values | `options: [{ label: 'M3 (3.4 mm)', value: 'm3' }, …]`; values are strings or numbers |
| `radio` | the union of its options' values | a select's `options` and default rule, for a few choices that are all on show |
| `text` | `string` | |

The builder checks every value it is called with, so a model that passes a
wrong one fails to compile at that call: `boltCircle(): 'count' must be at
least 1, got 0`, `boltCircle(): 'size' must be one of "m3", "m4", "m5",
"custom", got 'm6'`, `boltCircle(): 'count' must be a whole number, got 2.5`.

`type` is what the value is and `display` how its row is laid out: a display
never changes the value or the statement the dialog writes.

**Options.** A `select` and a `radio` share one option: `label` and `value`,
and optionally an `image`, a `description` (a line under the label), a
`group` (the heading it is listed under) and `keywords` (further words a
search finds it by; a non-empty list). An `image` is a relative path to an
image inside the module's directory, as `icon` is in
[`defineFeature`](./define-feature.md): `'./img/m3.svg'`, never `../` or a
URL. It is shown as a picture, so `currentColor` in an SVG draws black:
line art in a mid-tone (`stroke="#8a94a6"`) reads in both the light and the
dark theme. Any other option field is refused by name.

| Type | `display` | `columns` |
|---|---|---|
| `select` | `'list'` (the default): one row per option. `'grid'`: a grid of the options' images | `2`–`6`, with `'grid'` only |
| `radio` | `'list'` (the default): stacked. `'inline'`: on one line. `'buttons'`: a segmented row. `'cards'`: image tiles | `2`–`6`, with `'cards'` only |

`search: true` on a `select` lets its options be searched by label,
description and keywords; a `radio` takes no `search`. `columns` on any other
display is refused: `param 'size': 'columns' is for display: 'grid' — leave
it out`.

The [screw hole](#example-a-screw-hole-with-choices) below declares a grid of
images, cards, buttons and a searchable list.

**What the dialog shows is what the builder gets.** A value left out of a
call (or passed `null`) takes its default, and every control that always shows
a value resolves to the one it shows, declared or not:

| Declared | Untouched, the row shows | Left out, the builder gets | Empty, it blocks Apply |
|---|---|---|---|
| any type with a `default` | the default (a plain number row: empty, the default greyed) | the default | no |
| `boolean`, no default (toggle or `checkbox`) | off | `false` (`optional` changes nothing) | never empty |
| `select` or `radio`, no default | the first option offered | that option's value | never empty, unless no option is offered ("No options") |
| `select`, no default, `optional: true` | an empty choice, "—" | `undefined` | no |
| `radio`, no default, `optional: true` | none chosen | `undefined` | no |
| `select` with `multiple: true` | the `default`, else `None` | the `default`, else `[]` — never `undefined` (`optional` changes nothing) | no: an empty list is a value; fewer than `min` or more than `max` blocks |
| number with `display: 'slider'`, no default | the thumb and the input at `min` | `min` | only when the input is emptied by hand and the value is not `optional` |
| `number`, `integer`, `length`, `angle` (plain or `stepper`) or `text`, no default | an empty row (a text's `placeholder`) | required: `post(): 'height' is required` | yes: "Height is required." |
| the same, `optional: true` | an empty row | `undefined` | no |

A text over its `maxLength` or off its `pattern` blocks Apply with the reason.
A picked value that isn't `optional` (or a sketch with
`implicitDefault: true`) is required too: `standoff(): 'face' is required`. The resolved default is what the builder
fills, what the editor's catalog carries and what the dialog shows, so a row
left alone always builds what it shows.

The dialog's number rows take expressions and model variables
(`param()` values included), as the built-in dialogs do. A create writes
only the values the user changed, picks and the operation aside: a row left
alone shows the value the builder fills, so the call leaves it out. An
emptied number row shows its default greyed; an emptied text row with a
default writes `''`. Choosing "—" in an optional select writes nothing in a
create, and drops the value from the statement in an edit.

### How a row looks: `display`, `suffix`, `hint`, and a text's limits

`type` is what the value is; these fields are how its row looks. None of them changes the statement a dialog writes.

| Field | On | Rule |
|---|---|---|
| `display: 'slider'` | `number`, `integer`, `length`, `angle` | A track above the input, which stays: a variable or an expression still types in. Needs both `min` and `max`. Without a `default` the value resolves to `min` (the track always shows a position). `step` drives the track: left out, 1 for an `integer`, else a hundredth of the range. An integer slider's `min` is a whole number. |
| `display: 'stepper'` | `number`, `integer` only | − / + buttons beside the input, stepping by `step` (1 left out), kept inside `min` / `max`. Refused on a `length` or an `angle`. |
| `suffix` | the four number types | A short unit at the end of the input: a non-empty string of at most 8 characters. On an `angle` it replaces the "(°)" in the label. |
| `display: 'checkbox'` | `boolean` | A checkbox in place of the toggle. |
| `multiline` | `text` | `true` for a text of several lines: Enter is a new line, Ctrl/Cmd+Enter applies. Written as one single-quoted string with `\n` escapes. |
| `placeholder` | `text` | What the empty input shows: a non-empty string. |
| `maxLength` | `text` | The most characters, a whole number of 1 or more. |
| `pattern` | `text` | A regular expression, as a string, that the whole value must match (`'[A-Za-z0-9-]*'`, no anchors needed). It must compile. |
| `hint` | every value, pickers included | A line of small text under the row: a non-empty string. `description` stays the tooltip. |
| `aside` | every value, pickers included | What the card beside the dialog shows while this value's row has the focus, or the pointer rests on it: a non-empty list of static items — `{ note }`, `{ image }`, `{ divider: true }` — checked like the dialog's own `aside` ([feature-layout](feature-layout.md#a-values-own-aside)). A diagram of what the value measures. |

Leaving `display` out is the plain input (or the toggle): `'input'` and `'toggle'` are not values. A declared `default` must keep to `maxLength` and `pattern`, and so must a value a call passes: `fastener(): 'marking' must be at most 12 characters, got 14`.

### Options that depend on another value: `when`

An option of a `select` or a `radio` may carry `when`, written exactly as a
value's `visibleWhen`: `{ otherValue: scalar | scalar[] }`, every clause
holding. The dialog offers the option only while it holds; an option without
one is always offered.

```js
standard: { type: 'radio', display: 'buttons', options: [{ label: 'Metric', value: 'iso' }, { label: 'Imperial', value: 'unc' }] },
size: {
  type: 'select',
  options: [
    { label: 'M3', value: 'm3', when: { standard: 'iso' } },
    { label: 'M4', value: 'm4', when: { standard: 'iso' } },
    { label: '#4', value: 'n4', when: { standard: 'unc' } },
    { label: 'Custom', value: 'custom' },
  ],
},
```

- A clause names another typed-in value that holds one thing (not a picked
  value — only a row's `visibleWhen` reads picks — not a `multiple: true`
  select, not the value itself) and lists values it can take. Options may not wait on each other in a circle (`a` on `b`,
  `b` on `a`, or a longer chain): the declaration is refused, naming the chain.
- **The default must be offered at rest**, that is while every other value is
  at its own default. A declared `default` that is not offered there is
  refused. With no `default`, the value starts at the **first option offered
  there** (not blindly the first listed); if none is offered and the value is
  not `optional`, the declaration is refused. Every element of a
  `multiple: true` default must be offered there. A clause on a value with no
  default (an empty number) does not hold at rest.
- In the dialog, when the chosen option stops being offered the row moves to
  the first one offered (a list drops it) and that is written on Apply. A row
  with no option offered shows "No options"; it blocks Apply unless the value
  is `optional`.
- **`when` narrows the dialog only.** A call written by hand may pass any
  declared option whatever the other values are, and the builder gets it:
  `fastener(at, { standard: 'iso', size: 'n4' })` builds. Editing such a
  statement shows the value it holds. The value's type is still every option's
  value.

## A list of options: `select` with `multiple: true`

The one typed-in value that is a list. The dialog shows a popover with a check mark per chosen option that stays open while you toggle; the row reads the chosen labels, `N selected` above two, or `None`.

```text
finishes: {
  type: 'select', multiple: true, label: 'Finishes',
  options: [{ label: 'Deburr', value: 'deburr' }, { label: 'Chamfer', value: 'chamfer' }, { label: 'Polish', value: 'polish' }],
  default: ['deburr'],   // optional: a list of option values; left out it is []
  min: 0, max: 2,        // optional counts of chosen values
}
// this.values.finishes: ('deburr' | 'chamfer' | 'polish')[]   (never undefined; `optional` changes nothing)
// the dialog writes:    fastener(at, { finishes: ['deburr', 'polish'] })   — ['deburr'] for one, [] for none
```

- `this.values.<name>` is always a list, in the order the call wrote it (the dialog writes declaration order). A call must pass a list: one value alone is refused (`'finishes' must be a list of "deburr", "chamfer", "polish"`), as are a value that is no option, a value listed twice, and a count outside `min` / `max`.
- `default` is a list of distinct option values within `min` / `max`. `min` is a whole number ≥ 0, `max` a whole number ≥ 1, `min ≤ max ≤` the number of options. A `min` above 0 needs a `default` (the list would start empty, which its own `min` refuses).
- `display: 'grid'`, `columns` and `search` work as on a single select.
- Refused by name: `multiple` on a `radio`; `min` / `max` on a select without `multiple: true`; a multi-select as the call shape's rest value (`...name` is for a picker with `multiple: true`); a `visibleWhen` that names one (it can only name a value that holds one thing).
- The dialog edits a statement only when the argument is a plain list of string and number literals; a spread, a variable or a nested list is left to the code.

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
  static id = 'boltCircle';

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

## Example: a screw hole with choices

Every control on one dialog: buttons for the standard, a grid of screw
pictures that offers the chosen standard's sizes only (`when`), cards for the
head, a stepper, a checkbox, a slider with a unit and a hint, a text with
limits and a list of finishes. Its [layout](feature-layout.md) puts two rows
side by side, folds the rarely used ones away and shows a section drawing
beside the rows. The images are files next to the module, in `screw-hole/`.

```feature.js
// screw-hole.feature.js
import { Feature, defineFeature } from 'fluidcad/sdk';
import { Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4 } from 'fluidcad/math';

/** Each screw's clearance hole, head diameter and head height, in mm. */
const SCREWS = {
  m3: { clearance: 3.4, head: 6.5, headHeight: 3 },
  m4: { clearance: 4.5, head: 8, headHeight: 4 },
  m5: { clearance: 5.5, head: 10, headHeight: 5 },
  n4: { clearance: 3.3, head: 6, headHeight: 2.8 },
  n6: { clearance: 3.9, head: 7.5, headHeight: 3.5 },
};

/** A washer's thickness, in mm. */
const WASHER = 0.5;

/** Long enough to cut through anything a screw goes into. */
const THROUGH = 1000;

export class ScrewHole extends Feature.with({
  at: { picker: 'connector', label: 'At' },
  standard: {
    type: 'radio', display: 'buttons',
    options: [{ label: 'Metric', value: 'iso' }, { label: 'Imperial', value: 'unc' }],
  },
  size: {
    type: 'select', label: 'Screw', display: 'grid', columns: 3, search: true,
    options: [
      { label: 'M3', value: 'm3', image: './screw-hole/m3.svg', description: '3.4 mm clearance', when: { standard: 'iso' } },
      { label: 'M4', value: 'm4', image: './screw-hole/m4.svg', description: '4.5 mm clearance', when: { standard: 'iso' } },
      { label: 'M5', value: 'm5', image: './screw-hole/m5.svg', description: '5.5 mm clearance', when: { standard: 'iso' } },
      { label: '#4', value: 'n4', image: './screw-hole/n4.svg', description: '3.3 mm clearance', when: { standard: 'unc' }, keywords: ['inch'] },
      { label: '#6', value: 'n6', image: './screw-hole/n6.svg', description: '3.9 mm clearance', when: { standard: 'unc' }, keywords: ['inch'] },
    ],
  },
  head: {
    type: 'radio', display: 'cards', columns: 2,
    options: [
      { label: 'Plain', value: 'plain', image: './screw-hole/plain.svg', description: 'Nothing for the head' },
      { label: 'Counterbore', value: 'counterbore', image: './screw-hole/counterbore.svg', description: 'A flat recess the head sinks into' },
    ],
  },
  washers: { type: 'integer', display: 'stepper', default: 0, min: 0, max: 3, visibleWhen: { head: 'counterbore' }, hint: 'Each deepens the recess by 0.5 mm' },
  through: { type: 'boolean', display: 'checkbox', label: 'Through all', default: true },
  depth: { type: 'length', default: 10, min: 1, max: 50, display: 'slider', suffix: 'mm', hint: 'Measured from the surface', visibleWhen: { through: false } },
  marking: { type: 'text', optional: true, placeholder: 'A2-70', maxLength: 12, pattern: '[A-Za-z0-9-]*', hint: 'Letters, digits and dashes' },
  finishes: {
    type: 'select', multiple: true, default: ['deburr'], max: 2,
    options: [{ label: 'Deburr', value: 'deburr' }, { label: 'Chamfer', value: 'chamfer' }, { label: 'Polish', value: 'polish' }],
  },
}) {
  static id = 'screwHole';

  buildTool() {
    const { size, head, washers, through, depth } = this.values;
    const screw = SCREWS[size];
    const frame = this.frameOf(this.values.at);
    const length = through ? THROUGH : depth;
    const recess = head === 'counterbore' ? screw.headHeight + washers * WASHER : 0;
    if (!(length > recess)) {
      throw new Error(`screw hole: the hole (${length}) must be deeper than the recess for its head (${recess})`);
    }
    const tools = [this.sunk(Primitives.makeCylinder(screw.clearance / 2, length), length, frame)];
    if (recess > 0) {
      tools.push(this.sunk(Primitives.makeCylinder(screw.head / 2, recess), recess, frame));
    }
    return tools;
  }

  /**
   * A cylinder built on the XY plane, moved to end at the frame's origin, `depth` into the material.
   * @param {import('fluidcad/sdk/kernel').Shape} cylinder
   * @param {number} depth
   * @param {import('fluidcad/math').Plane} frame
   */
  sunk(cylinder, depth, frame) {
    const lowered = ShapeOps.transform(cylinder, Matrix4.fromTranslation(0, 0, -depth));
    const placed = ShapeOps.transform(lowered, Matrix4.fromBasis(frame.xDirection, frame.yDirection, frame.normal, frame.origin));
    cylinder.dispose();
    lowered.dispose();
    return placed;
  }
}

export const screwHole = defineFeature(ScrewHole, {
  label: 'Screw hole',
  description: 'A clearance hole for a screw, plain or counterbored',
  group: 'create',
  operations: ['remove'],
  call: ['at', { standard: 'standard', size: 'size', head: 'head', washers: 'washers', through: 'through', depth: 'depth', marking: 'marking', finishes: 'finishes' }],
  width: 'wide',
  layout: [
    'at',
    { row: ['standard', 'through'], widths: [2, 1] },
    'size',
    { row: ['head', 'washers'] },
    { note: 'The recess is sized for the head of the screw.', visibleWhen: { head: 'counterbore' } },
    'depth',
    { section: 'Finish', collapsed: true, items: [{ row: ['marking', 'finishes'] }] },
  ],
  aside: [{ image: './screw-hole/section.svg', alt: 'A section through the hole: clearance, recess and depth' }],
});
```

A cover plate with an M4 counterbored hole at its centre. The size is written
because the user changed it; `standard` stays at its default and is left out.
`finishes` is always an array literal.

```fluid.js
import { part, sketch, line, extrude, connector } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";
import { screwHole } from "./screw-hole.feature.js";

export const cover = part("Cover plate", () => {
  sketch("xy", () => {
    const b = line([-31, -19], [29, -21]);
    const r = line([29, -21], [31, 19]);
    const t = line([31, 19], [-29, 21]);
    const l = line([-29, 21], [-31, -19]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-30, -20]);
    distance(b.start(), b.end(), 60);
    distance(r.start(), r.end(), 40);
  });
  const plate = extrude(8);
  const mount = connector("mount", plate.endFaces());

  screwHole(mount, { size: "m4", head: "counterbore", washers: 1, finishes: ["deburr", "chamfer"] });
});
```

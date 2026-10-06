---
id: api/define-feature
title: "defineFeature(FeatureClass, meta) — a custom feature's builder, metadata and call shape"
summary: "Turns a Feature.with() class into the builder a model calls, from fluidcad/sdk: the metadata gives it its Custom dropdown cell and dialog (label, description, icon, group), its operations (the default is add when offered, else the first listed, and needs no chain), its call shape (positional values, one object of options, one trailing ...rest list) that both the builder and the dialog read and write, ghost and contexts. The kind is read from the class. Refused by name: id, defaultOperation, illustration, onChange, class, params, kind."
tags: [api, sdk, custom-feature, metadata, call-shape, type]
symbols: [defineFeature, DefineFeatureMeta, CallShape, FeatureOperation]
seeAlso: [concepts/custom-features, api/feature, api/feature-params, api/feature-layout, api/register-builder, api/draft]
---

# defineFeature

Imported from `fluidcad/sdk`.

```ts
defineFeature(FeatureClass, {
  label: string;                                  // the dropdown cell's and the timeline row's name
  description?: string;                           // tooltip: "label — description"
  icon?: string;                                  // './standoff.svg' — an image beside the module
  group: 'create' | 'modify';                     // where it sorts in the Custom dropdown
  operations?: ('add' | 'new' | 'remove')[];      // a tool's operations; left out, none
  call: CallShape;                                // how the builder's arguments map to the values
  ghost?: boolean;                                // false: the dialog draws no preview
  contexts?: ['part'];                            // where it may be used; parts only so far
}): (...args: FeatureArgs) => InstanceType<FeatureClass>

type CallShape = (valueName | `...${listValueName}` | { [optionKey: string]: valueName })[];
```

`FeatureClass` extends `Feature.with({ … })` (see [[api/feature]]). The
values and the kind come from the class: one that implements `buildTool()`
is a tool, one that overrides `build()` a modifier.

The returned function is the **builder**. Export it by name from the
`*.feature.js` module: the editor finds it there and writes
`import { standoff } from './standoff.feature.js'`. Called in a model, it
reads its arguments by the call shape, checks each value against its
declaration, fills the defaults and adds the feature to the scene.

```js
export const standoff = defineFeature(Standoff, {
  label: 'Standoff',
  description: 'A boss with a bore through it, standing on a planar face',
  icon: './standoff.svg',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
});

standoff(pad.endFaces(), { outer: 6, hole: 3.2 });   // in a model
```

The metadata is checked where the module loads: a mistake names the
feature and the field (`feature 'acme.standoff': the value 'width' has no
place in the call shape`), the editor greys the feature's dropdown cell with
that message, and a model that imports the module fails to compile with it.

## Fields

| Field | Meaning |
|---|---|
| `label` | Required. The Custom dropdown cell's caption and the timeline row's name ("Bolt circle"); `.name('…')` on a statement still wins. |
| `description` | The cell's tooltip, after the label. |
| `icon` | A relative path to an image inside the module's directory (`.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`): `'./standoff.svg'`, never `../` or a URL. Only the files the metadata declares are served: this icon, the `image` of each option of a `select` or a `radio` ([feature-params](./feature-params.md)), and each `image` of the `layout` and the `aside` ([feature-layout](./feature-layout.md)). A generic icon stands in when left out. Line art in a mid-tone reads in both the light and the dark theme. |
| `group` | Required: `'create'` or `'modify'`. The dropdown lists create features first, then modify, each sorted by label. |
| `operations` | A tool's operations, which its dialog offers as tabs (see below). A modifier takes none. |
| `call` | Required: the call shape (see below). Every value appears in it exactly once. |
| `ghost` | `false` turns the dialog's preview off. A tool previews by default; a modifier only when its class overrides `ghost(ctx)`, and `ghost: true` on one that doesn't is refused. |
| `contexts` | `['part']`, the only context so far: custom features run in parts, not at the top level of an assembly file. `'assembly'` is refused ("custom features run in parts only for now — 'contexts' takes 'part'"). |
| `layout`, `width`, `aside` | Optional: how the dialog is laid out — rows, sections, tabs, notes and images; a wider dialog; static items beside the rows. See [feature-layout](feature-layout.md). Left out, the layout is derived from the values' `group` and `tab`. |

## Operations and the default operation

`operations` lists what a tool's statement may do with its solids: `'add'`
(fuse into the solids in scope), `'new'` (keep its solids apart) and
`'remove'` (cut). A statement **without an operation chain applies the
default**: `'add'` when it is offered, else the first listed. So:

| `operations` | Default | The dialog | A model writes |
|---|---|---|---|
| `['add', 'new']` | add | Add and New tabs, opening on Add | `standoff(f)`, `standoff(f).new()` |
| `['remove']` | remove | no tabs | `boltCircle('z')` — cuts with no chain |
| `['new', 'remove']` | new | Remove and New tabs, opening on New | `pocket(s)`, `pocket(s).remove()` |
| left out | add | no tabs | `x(f)`; any chain is taken |

- **The default needs no chain.** The dialog writes none for it; an edit
  keeps a chain the statement already spells out (`.remove()` on a feature
  that removes anyway).
- **An operation the feature doesn't offer fails its row**, with the rest of
  the model building: `boltCircle(): .add() is not an operation this feature
  offers — it offers 'remove'; 'remove' is its default and needs no chain`.
- **Scope.** A feature with operations also gets the dialog's Scope row,
  written as `.scope(…)` (hidden while the operation is New: a new solid
  fuses with nothing).
- `defaultOperation` is not a field: the rule above decides it, and naming
  it is refused.

## The call shape

The call shape is the one description of the call: the builder parses its
arguments with it, and the dialog writes and reads statements with it, so a
statement the dialog wrote is exactly one the builder reads back. In order:

1. **positional values**: `'face'`;
2. at most one **object of options**, each key naming a value:
   `{ height: 'height', outer: 'outer' }` (a key may differ from the value's
   name: `{ dia: 'diameter' }`);
3. at most one trailing **rest value**, a list spread over the remaining
   arguments: `'...faces'` (the value must be a list picker).

| Call shape | A model writes |
|---|---|
| `['face', { height: 'height', outer: 'outer', hole: 'hole' }]` | `standoff(e.endFaces(), { height: 12 })` |
| `['around', { count: 'count', circle: 'circle', … }]` | `boltCircle('z', { count: 6 })` |
| `['at', { diameter: 'diameter', height: 'height', hole: 'hole' }]` | `boss([bolt, s.geometries.a], { height: 4 })` |
| `['angle', '...faces']` (`draft()`'s own) | `draft(5, e.sideFaces(), e2.sideFaces())` |

- Any argument may be left out when the values it holds may be: a trailing
  one is dropped, an option loses its key, an empty object of options goes.
  A value may be left out when it resolves to a default — a boolean, a
  select, a radio, a slider and a list of options always do — or is optional
  (the table in [[api/feature-params]]). A positional value left out ahead of a later
  argument is passed as `undefined` (the dialog writes its default there:
  `draft(5, …)`).
- With both options and a rest, an argument that is not a plain object is
  read as the rest: `f(6, a, b)` and `f(6, { depth: 10 }, a, b)` both read.
- **In the editor**, the builder's arguments are typed from the shape, and a
  misspelled value name in `call` is marked ("Did you mean …").
- **At run time**, a call that doesn't fit throws at the call, so the model
  fails to compile: `standoff(): unknown option 'hieght' — the options are
  'height', 'outer' and 'hole'`, `standoff(): takes at most 2 arguments,
  got 3`.

**What the dialog can edit.** A statement in the shape, with its options as
an object literal (plain or quoted keys, shorthands) and its operation
chains (`.add()`, `.new()`, `.remove()`, `.scope(…)`) right after the call;
other chains, such as `.name('…')`, are kept as written. A statement written
another way still runs if the builder can read it, but its timeline row
opens as not editable: an options object held in a variable or spread
(`{ ...size }`), a computed key, a string or object where a number goes, a
select, a radio, a text or a list of options given as anything but a plain
literal (`size: screw`, `finishes: [...common]`: "screwHole()'s 'size' is not
a plain string or number").
The message ends "— not editable in the dialog; edit the statement in the
source".

**What the dialog writes.** A create writes the picks, the operation and
only the typed-in values the user changed. Every row left alone shows the
value the builder fills for it, so the call leaves it out and still builds:
`grille(e.endFaces())` for a grille whose pattern (a select) and chamfer (a
boolean) declare no default gets the first pattern and no chamfer, as its
dialog showed. What each kind of row shows untouched, and which empty rows
block Apply, is one table in [[api/feature-params]]. An edit
rewrites only what the user changed; a value the statement leaves out opens
on that same default and stays out unless changed.

**Choosing a shape.** Follow the built-ins: what is picked first and
positional (`standoff(face, …)`, `boltCircle(axis, …)`), sizes in one object
of options, a list of picks as one array argument (`boss([a, b])`) or a rest
(`draft(angle, ...faces)`).

## Fields refused by name

| Field | Message |
|---|---|
| `id` | `leave 'id' out — the feature's id is its class's static id` |
| `defaultOperation` | `leave 'defaultOperation' out — a feature adds by default when it offers 'add', else it applies the first of its 'operations'` |
| `illustration` | `leave 'illustration' out — illustrations aren't supported (custom controls are planned)` |
| `onChange` | `leave 'onChange' out — onChange hooks aren't supported (custom controls are planned)` |
| `class`, `params`, `kind` | `defineFeature(Standoff): leave 'kind' out — it is read from the class: …` (the class is the first argument; its values are declared with `Feature.with()`) |

Any other unknown field is refused as a typo: `feature metadata: unknown
field 'lable' — the fields are …`. Picker fields refused by name
(`tangents`, `connector` on an axis, a picker's `default`) are listed in
[[api/feature-params]].

A class without `Feature.with()` values is refused ("Bare declares no
values — declare them with Feature.with({ … })"), as is one that implements
neither `buildTool()` nor `build()`. The explicit path, `registerBuilder`
with the whole metadata, is in [[api/register-builder]].

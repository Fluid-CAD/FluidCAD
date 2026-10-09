---
id: concepts/custom-features
title: Custom features — your own feature types in *.feature.js modules
summary: "A custom feature is a feature type a project writes in JavaScript: a Feature.with() class whose buildTool() returns its solids, exported through defineFeature() from a *.feature.js module. The editor finds it by scanning the module's exports (no init.js), lists it under the toolbar's Custom dropdown with a dialog built from its declared values, a live preview behind a toggle, Apply that writes the import and the call, and timeline edits; models call it like a built-in, and repeat, copy and fillet its buckets. The module re-evaluates on every render, so never instanceof your own class; saving its code rebuilds its statements with no restart."
tags: [concept, sdk, custom-feature, feature]
seeAlso: [api/feature, api/define-feature, api/feature-params, api/feature-layout, api/register-builder, api/sdk-kernel, api/sdk-occt, api/draft, api/repeat, concepts/scene-graph]
---

# Custom features

A custom feature is a feature type your project defines: a standoff, a bolt
circle, a vent grid. It lives in a `*.feature.js` module in the project, and
from then on it behaves like a built-in feature:

- the part toolbar's **Custom** dropdown (the last button on the bar) lists it;
- its dialog is built from the values it declares: picks in the viewport or
  the timeline, typed values, tabs and groups;
- the dialog draws a live preview once its **Preview** toggle is on, green for
  what it adds and red for what it cuts (the toggle starts off, and stays on
  for a feature the user turned it on for);
- **Apply** writes `import { standoff } from './standoff.feature.js'` and the
  call into the model;
- double-clicking its timeline row opens the same dialog on the statement;
- models call it in code, and `repeat()`, `copy()`, `.new()`, `.scope()` and
  fillets on its faces and edges work as they do on `extrude()`.

## When to write one

Write a custom feature when one construction (several kernel steps, or
geometry that takes code to describe) recurs across models or places in a
model with different values, and it should be **one statement, one dialog and
one timeline row**: a PCB standoff on any face, a ring of clearance holes
around any axis, bosses at a set of connectors.

Don't write one for:

- **one-off geometry**: write the statements in the model;
- **the same geometry again in one model**: `repeat()` re-applies a feature at
  new positions, `copy()` duplicates a finished shape (see [[api/repeat]]);
- **a whole part reused with other dimensions**: a `part()` with `param()`
  values, inserted where it is needed (see [[concepts/assemblies]]).

## Anatomy of a feature module

A `*.feature.js` module holds a class and the builder it exports:

1. **The class** extends `Feature.with({ … })`, which declares the feature's
   values: each is typed in (`{ type: 'length', default: 10 }`) or picked
   (`{ picker: 'face' }`). `this.values` is typed from them, in plain
   JavaScript.
2. **`static id`** is the feature's type, namespaced: `'acme.standoff'`.
3. **`buildTool()`** returns the solids the feature adds or cuts, built where
   its picked references stand. The base applies the operation (add, new or
   remove), fuses or cuts, and carries the buckets `setBuckets()` names.
4. **`defineFeature(Class, { … })`** describes the feature for the editor
   (label, group, operations, the call shape) and returns the builder that
   models call. Export it by name.

```feature.js
// standoff.feature.js
// A PCB standoff: a boss with a bore through it, standing on a planar face.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

export class Standoff extends Feature.with({
  face: { picker: 'face', label: 'On face', surface: 'planar' },
  height: { type: 'length', default: 10, min: 0 },
  outer: { type: 'length', default: 6, min: 0, label: 'Boss diameter' },
  hole: { type: 'length', default: 3, min: 0, label: 'Hole diameter' },
}) {
  static id = 'acme.standoff';

  buildTool() {
    const { height, outer, hole } = this.values;
    if (!(hole < outer)) {
      throw new Error(`standoff: the hole (${hole}) must be narrower than the boss (${outer})`);
    }
    const faces = this.facesOf(this.values.face);
    if (faces.length !== 1) {
      throw new Error(`standoff: pick one planar face to stand on (got ${faces.length} faces)`);
    }
    const plane = faces[0].getPlane();
    const origin = plane.projectPoint(faces[0].center());

    // Built standing on the XY plane, its faces sorted there, then placed.
    const boss = Primitives.makeCylinder(outer / 2, height);
    const bore = Primitives.makeCylinder(hole / 2, height);
    const tube = BooleanOps.cutShapes(boss, bore);
    boss.dispose();
    bore.dispose();

    const tolerance = 1e-6 * Math.max(height, outer);
    const all = tube.getSubShapes('face');
    const start = all.filter(f => Math.abs(f.getBoundingBox().maxZ) < tolerance);
    const end = all.filter(f => Math.abs(f.getBoundingBox().minZ - height) < tolerance);
    const walls = all.filter(f => !start.includes(f) && !end.includes(f));
    const side = walls.filter(f => f.getBoundingBox().maxX > hole / 2 + tolerance);
    const internal = walls.filter(f => !side.includes(f));

    const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection, plane.normal, origin);
    const placed = ShapeOps.transformTracking(tube, frame, all);
    tube.dispose();
    // Each group as the faces it became once placed.
    const [startFaces, endFaces, sideFaces, internalFaces] = [start, end, side, internal]
      .map(group => group.map(f => placed.images[all.indexOf(f)]).filter(f => f !== null));

    this.setBuckets({
      startFaces,
      endFaces,
      sideFaces,
      internalFaces,
      startPlane: new Plane(origin, plane.xDirection, plane.normal),
    });
    return [placed.shape];
  }
}

export const standoff = defineFeature(Standoff, {
  label: 'Standoff',
  description: 'A boss with a bore through it, standing on a planar face',
  group: 'create',
  operations: ['add', 'new'],
  call: ['face', { height: 'height', outer: 'outer', hole: 'hole' }],
});
```

A model imports the builder by name and calls it with the call shape the
metadata declares, `standoff(face, { height, outer, hole })`:

```fluid.js
import { part, sketch, line, circle, extrude, fillet, repeat } from "fluidcad/core";
import { coincident, horizontal, vertical, distance, diameter, fix } from "fluidcad/constraints";
import { standoff } from "./standoff.feature.js";

// An 80 × 50 × 3 PCB mounting plate with a standoff on a pad at each corner.
export const pcbPlate = part("PCB plate", () => {
  sketch("xy", () => {
    const b = line([-41, -26], [39, -24]);
    const r = line([39, -24], [41, 26]);
    const t = line([41, 26], [-39, 24]);
    const l = line([-39, 24], [-41, -26]);
    coincident(b.end(), r.start());
    coincident(r.end(), t.start());
    coincident(t.end(), l.start());
    coincident(l.end(), b.start());
    horizontal(b);
    vertical(r);
    horizontal(t);
    vertical(l);
    fix(b.start(), [-40, -25]);
    distance(b.start(), b.end(), 80);
    distance(r.start(), r.end(), 50);
  });
  extrude(3);

  // The front-left pad, 6 mm in from both edges, 1 mm proud of the plate.
  sketch("xy", () => {
    const p = circle([-34, -19], 9);
    fix(p.center(), [-34, -19]);
    diameter(p, 10);
  });
  const pad = extrude(4);

  // An M3 standoff, its height the feature's default (10).
  const post = standoff(pad.endFaces(), { outer: 6, hole: 3.2 });
  const rim = fillet(0.5, post.endEdges());

  // The other three corners: the pad, its standoff and the rounded rim.
  repeat("linear", ["x", "y"], { count: [2, 2], offset: [68, 38] }, pad, post, rim);
});
```

`post.endEdges()` names the standoff's top rims because `buildTool()` put its
top faces in `endFaces` (edge buckets left out are derived from the faces).
Without `setBuckets()` the feature's accessors are empty: `post.endEdges()`
names nothing, so a fillet on it fails, and the editor names picks on the
standoff's geometry with filters instead.

## What the dialog can hold

The dialog is drawn from the declaration: one row per value, in the order
`Feature.with()` lists them. What a value **is** (`type`, or `picker`) and how
its row **looks** are separate, and only the first reaches the statement: two
features that differ in looks alone write the same code.

```js
pattern: { type: 'radio', display: 'buttons', options: [{ label: 'Slots', value: 'slots' }, { label: 'Holes', value: 'holes' }] },
count: { type: 'integer', display: 'stepper', default: 5, min: 1, max: 40 },
pitch: { type: 'length', display: 'slider', default: 6, min: 2, max: 20, suffix: 'mm', hint: 'Centre to centre' },
shape: {
  type: 'select',
  options: [
    { label: 'Round', value: 'round', when: { pattern: 'holes' } },
    { label: 'Hex', value: 'hex', when: { pattern: 'holes' } },
    { label: 'Straight', value: 'straight', when: { pattern: 'slots' } },
  ],
},
```

- **Each value's row** — a select as a list or a grid of images, a radio as
  buttons or cards, a slider, a stepper, a checkbox, a unit, a hint, a text's
  limits, a select that holds several options, and options offered only for
  another value's choice (`when`): [[api/feature-params]], which also has the
  one table of what an untouched row shows and what the builder gets.
- **Where the rows sit** — rows side by side, sections that fold, tabs, notes,
  pictures, a wider dialog and a column beside the rows (`layout`, `width`,
  `aside`): [[api/feature-layout]]. A value's own `group` and `tab` are the
  short form for a simple dialog.
- **The call the dialog writes and reads back**: [[api/define-feature]].

## How the editor finds it

- **Discovery is an export scan.** Every `*.feature.js` file in the workspace
  (not under `node_modules`, a dot directory, or a gitignored path) is
  evaluated, and each **named** export that is a feature builder becomes a
  catalog entry. A default export is skipped (the dialog writes named
  imports). Nothing is registered in `init.js`.
- **The suffix matters.** `*.feature.js` is not a model suffix, so the
  engine skips the module's own stack frames: a statement's timeline row and
  edits point at the model's call line.
- **Entries that can't be offered** show as greyed cells in the Custom
  dropdown with the reason as their tooltip: a module that fails to evaluate
  (a refused metadata field is one), a module that exports no feature ("the
  module exports no feature — export the builder …"), and two builders that
  share one id (both are refused: "the feature id 'acme.standoff' is used by
  more than one builder …").
- **The dropdown** lists create-group features first, then modify-group
  ones, each sorted by label, with the module's `icon` (an image next to it)
  or a generic one. Built-in features keep their own toolbar buttons.
- **The UI never runs feature code.** The engine evaluates the module and
  sends the metadata to the page as JSON.

## Lifecycle: re-evaluation, the cache, and saving the module

- **The module is evaluated anew on every render**, and by the editor's
  catalog scan in a throwaway scene. Each evaluation makes a new class, so
  never test `x instanceof Standoff`: the engine compares features by their
  `static id` and values, never by class. Keep no state at module level
  between renders, and build no geometry at module level.
- **A value change rebuilds through the cache.** A statement whose values
  match the last render's is served from the cache; one whose values changed
  rebuilds, and so does everything after it, as for any feature.
- **Saving the module rebuilds its features.** When a `*.feature.js` file, or
  a workspace module it imports, is saved, every model whose last render read
  it rebuilds the statements of its features though their values match;
  statements before the first of them stay cached. An open dialog's preview,
  when on, redraws with the saved code. No engine restart. Unsaved editor buffers of a
  feature module don't reach the engine: saving is the trigger.

## Errors, and where they show

| What went wrong | Where it shows |
|---|---|
| Metadata refused (`defineFeature()` checks it where the module loads) | the module's catalog entry is greyed; a model importing it fails to compile with the message, such as `feature 'acme.standoff': param 'face': unknown field 'surfce' for a face picker — its fields are …` |
| A call the builder can't read (a wrong value, a missing required one) | the model fails to compile: `standoff(): 'height' must be at least 0, got -2` |
| `buildTool()` throws, or returns nothing | that statement's row fails with the message; the rest of the model builds |
| An operation the feature doesn't offer (`.remove()` on an add/new feature) | that row fails: `standoff(): .remove() is not an operation this feature offers — it offers 'add' and 'new'; 'add' is its default and needs no chain` |

## Limits

- **Parts only.** A custom feature runs in a part body or a part file, not at
  the top level of an `*.assembly.js` file (`contexts` takes only `'part'`).
- **Node built-ins are blocked** in feature modules as in models (`fs`,
  `child_process`, `net`, `http`, `os`, `worker_threads`, `vm`, …).
- **Standard buckets only:** `startFaces`, `endFaces`, `sideFaces`,
  `internalFaces`, `capFaces` and their edges. There are no custom named
  buckets.
- **No custom dialog controls or illustrations:** the dialog is built from
  the declared values (see [[api/feature-params]]).

See [[api/feature]] for the class, [[api/define-feature]] for the metadata
and call shapes, [[api/feature-params]] for the values and pickers,
[[api/register-builder]] for the explicit path, [[api/sdk-kernel]] for the
geometry `buildTool()` builds with, and [[api/sdk-occt]] for raw
OpenCascade. `draft()` is the engine's own feature written on the same base
(see [[api/draft]]).

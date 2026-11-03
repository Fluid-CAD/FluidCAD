---
id: api/define-part
title: "definePart(FeatureClass, meta) — a custom feature as an insertable part, its values by id and its frames as connectors"
summary: "From fluidcad/sdk, exported from a *.part.js module: turns a Feature.with() tool class into a part definition that insert() takes with the feature's typed-in values by id (insert(gearPart, { teeth: 18 })), the same declarations, defaults, ranges and pictures checking them; every picked value must be optional and is left out. The body builds the feature as a new solid at the part's own origin and makes one connector per frame the class declares (Feature.with(params, { frames: { axis: {} } }) → instance.connectors.axis). meta: label (required; also the part's name unless name), description, icon, layout, width, aside — the feature dialog's rows less its picks, its width and aside are borrowed when left out; image paths are relative to the defining module and may climb into the package. Equal values share one template; a bad id, a bad value or a configuration name is a build error on the insert's row. The part follows the part rules and its rows are read-only. Also documents GeneratedSchema (getSchema()), GeneratedMeta and GeneratedMarker, shared with defineAssembly."
tags: [api, sdk, custom-feature, generated, part, assembly, type]
symbols: [definePart, DefinePartMeta, DefinablePartClass, GeneratedPartDefinition, TypedInParams, GeneratedMeta, GeneratedSchema, GeneratedKind, GeneratedAssetBase, GeneratedMarker]
seeAlso: [api/feature-frames, api/define-assembly, api/generator, api/insert, api/mate, api/feature, api/define-feature, api/feature-layout, concepts/custom-features, concepts/packages, concepts/assemblies]
---

# definePart

```ts
definePart(FeatureClass, meta: DefinePartMeta): GeneratedPartDefinition   // fluidcad/sdk, exported from a *.part.js module

type DefinePartMeta = Omit<GeneratedMeta, 'layout'> & { layout?: FeatureLayout<TypedInParams<P>> };
type GeneratedMeta = {          // definePart's and defineAssembly's metadata
  label: string;                // the Custom dropdown's and the Insert dialog's name; the part's name unless `name`
  description?: string;         // a sentence under the label
  icon?: string;                // relative to this module; may climb into the package: '../features/icons/gear.png'
  layout?: FeatureLayout;       // the dialog's rows over the values (api/feature-layout)
  width?: 'wide' | 'wider';     // how wide the dialog opens
  aside?: FeatureStaticItem[];  // notes, images and dividers beside the rows
  name?: string;                // the name each inserted part is built with; `label` when left out
};
type TypedInParams<P> = { [K in keyof P as P[K] extends { type: unknown } ? K : never]: P[K] };  // the feature's values less its picks
type DefinablePartClass = Feature.with() class & { id: string; params: FeatureParams };            // a tool: implements buildTool()

class GeneratedPartDefinition extends PartDefinition {   // what insert() takes, like a part() definition
  readonly generated: GeneratedMarker;                   // { kind: 'part', id: <the feature's id> }
  getSchema(): GeneratedSchema;                          // a fresh JSON copy each call
}
type GeneratedMarker = { kind: GeneratedKind; id: string };
type GeneratedKind = 'part' | 'assembly';
type GeneratedSchema = {
  kind: GeneratedKind; definitionKind: 'generated';
  id: string;                                   // a part: its feature's id (`gear`, `@fluidcad/gears:gear` from a package)
  label: string; description?: string; icon?: string;
  params: Record<string, ParamSpecSnapshot>;    // the values an insert takes, by id, defaults resolved
  layout: FeatureLayout; width?: 'wide' | 'wider'; aside?: FeatureStaticItem[];
  connectors: string[];                         // a part: its feature's frames; [] for a generated assembly
  assetBase: { layout: GeneratedAssetBase; aside?: GeneratedAssetBase };
};
type GeneratedAssetBase = 'definition' | 'class';   // the module an image path resolves against

// In an assembly (api/insert):
insert(gearPart, { teeth: 18, width: 12 }): Instance   // values by id; instance.connectors.<frame name>
```

A custom feature's values are its interface; `definePart` makes them the
interface of a part too. The feature's declarations check the insert's
values (types, defaults, ranges, options), the editor opens the feature's
own dialog on it, and the frames the feature declares become the part's
connectors. No part body re-declares the values with `param()`.

Write one when a feature *is* a part: a gear, a bushing, a screw, an
extrusion profile — something inserted into an assembly and mated, not an
operation on another part. A whole assembly made by code is
[[api/define-assembly]].

## Example: a gear part

The gear feature declares an `axis` frame and sets it in its build
([[api/feature-frames]]). Its `at` pick is optional: a model may call
`gear({ teeth: 24 })` and the gear stands on the XY plane.

```js
// features/gear.feature.js (abridged)
export class Gear extends Feature.with({
  at: { picker: ['face', 'edge', 'connector', 'point'], optional: true, label: 'At' },
  teeth: { type: 'integer', display: 'stepper', default: 24, min: 4, max: 1000 },
  width: { type: 'length', default: 10, min: 0.01, label: 'Face width' },
  // … module, bore, hub, phase, offset, flip …
}, {
  frames: { axis: { label: 'Gear axis' } },   // origin on the axis, Z up it, X the phase reference
}) {
  static id = 'gear';

  buildTool(ctx) {
    const frame = this.placement(ctx);         // where the gear stands: XY, or `at`
    // … build the toothed solid, place it with frame.matrix, setBuckets(…) …
    this.setFrames({ axis: frame.axis });      // a Plane: origin, X direction, normal
    return [placed.shape];
  }
}
```

```js
// parts/gear.part.js
import { definePart } from 'fluidcad/sdk';
import { Gear } from '../features/gear.feature.js';

export const gearPart = definePart(Gear, {
  label: 'Gear',
  description: 'A spur, helical or herringbone gear with involute teeth, on its axis connector',
  icon: '../features/icons/gear.png',
});
```

An assembly inserts it with values by id and mates it on `axis`. Two gears
of module 1.5 with 18 and 36 teeth sit 1.5 × (18 + 36) / 2 = 40.5 mm apart,
the distance between the gearbox plate's two shaft connectors:

```js
// gearbox.assembly.js
import { assembly, insert, mate, relation } from 'fluidcad/core';
import { gearPart } from './parts/gear.part.js';
import { gearPlate } from './parts/gear-plate.part.js';

export const gearbox = assembly('gearbox', () => {
  const plate = insert(gearPlate).grounded();
  const pinion = insert(gearPart, { teeth: 18, module: 1.5, width: 12, bore: 'round', boreDiameter: 8 }).name('Pinion');
  const wheel = insert(gearPart, { teeth: 36, module: 1.5, width: 12, bore: 'round', boreDiameter: 10 }).name('Wheel');

  // The plate's connectors point up out of its top face, the way the gears grow: .flip().
  const drive = mate('revolute', plate.connectors.pinionShaft, pinion.connectors.axis).flip();
  const driven = mate('revolute', plate.connectors.wheelShaft, wheel.connectors.axis).flip();
  relation('gear', drive, driven, 0.5).reverse();   // 18 teeth drive 36, the other way
});
```

A package exports it from `parts/` and a consumer imports it by the
package's name: `import { gearPart } from '@fluidcad/gears'`
([[concepts/packages]]). A complete module with a frame and its
`definePart`, runnable: the bushing in [[api/feature-frames]].

## What the class must be

`definePart()` checks the class where the module loads and throws, naming
`definePart(<Class>)`:

| The class | Message |
|---|---|
| not a `Feature.with()` class | `definePart(): the first argument is the feature's class, one that extends Feature.with({ … }), got a function` |
| declares no values | `definePart(Gear): Gear declares no values — declare them with Feature.with({ … }): …` |
| a modifier (overrides `build()`) | `definePart(Modifier): Modifier overrides build() — it changes solids it is handed, so it makes no part on its own; a generated part runs a tool, one that implements buildTool()` |
| no `buildTool()` | `definePart(Gear): Gear implements no buildTool() — …` |
| a picked value that is not optional | `definePart(Gear): 'face' is a picked value the feature requires — a generated part takes typed-in values only, so each picked value must be optional (optional: true); the part leaves it out` |
| only removes material | `definePart(Spur): the feature only offers 'remove' — a generated part builds it as a solid of its own, so it must offer 'new' or 'add'` |

- **Values only.** The part's values are the feature's typed-in ones
  (`TypedInParams`). Every picked value must be `optional: true`; the part
  leaves it out, so `buildTool()` reads it as `undefined` and builds at the
  part's own origin. Placing the part is the assembly's job: a mate, or a
  pose.
- **A new solid.** The body builds the feature as `.new()` — `.add()` when
  its metadata offers `add` but not `new`, which in a part holding nothing
  else is the same solid.
- **Frames become connectors.** Each frame the class declares is a connector
  of that name on every instance. A declared frame the build doesn't set is
  a build error in the part (`gear: its build set no frame 'axis' — set it
  with this.setFrames({ axis: plane })`).
- The feature need not be `defineFeature`d: `definePart(Gear, …)` works on
  a class no model calls. When it is, both share the class and its id.

## The metadata

| Field | Rule |
|---|---|
| `label` | required: the Custom dropdown's and the Insert dialog's name, and the part's name unless `name` is given |
| `description` | a sentence under the label; pack warns when it is missing (`undocumented-fields`) |
| `icon` | an image by a path relative to the defining module; it may climb out of the module's folder, never out of the package: `'../features/icons/gear.png'` |
| `layout` | the dialog's rows over the part's values ([[api/feature-layout]]), its images relative to this module. Left out: the feature dialog's rows, less every picked value's row and any section or tab left holding no value; with no feature dialog, derived from the values' `group` and `tab` |
| `width` | `'wide'` or `'wider'`; left out, the feature dialog's |
| `aside` | notes, images and dividers beside the rows, images relative to this module; left out, the feature dialog's |
| `name` | the name each inserted part is built with; `label` when left out |

Refused by name, each with why: `class` (the first argument), `params` (the
values are the class's), `call` ("a generated definition is inserted, not
called: insert(def, { … }) takes its values by id"), `operations`,
`buckets` and `frames` (declare them on the class). Any other field is
refused as unknown: "`definePart(Spur): unknown field 'group' — the fields
are label, description, icon, layout, width, aside, name`". The layout is
checked over the part's values, so a picked value placed in it is an error:
"`definePart(Spur): layout: names 'at', which is not one of the feature's
values`".

## Inserting it

`insert(gearPart, { teeth: 18 })` takes the values **by id** (`teeth`, never
the label "Teeth"), checked and defaulted as the feature's call checks them
([[api/insert]]):

- **Equal values share one template.** Two inserts whose values, defaults
  filled, are equal share one part per scene: `insert(gearPart)` and
  `insert(gearPart, { teeth: 24 })` (24 the default) build once. Across
  renders an unchanged insert keeps its built part; a changed value rebuilds
  it (a generator's templates are kept longer: [[api/generator]]).
- **A bad id, a refused value or a configuration name is a build error on the
  insert's row**, and the insert is an empty part; the rest of the assembly
  renders:
  - `part 'Gear': 'teth' is not one of its values — did you mean 'teeth'? its values are teeth, width, …`
  - `part 'Gear': 'at' is a picked value of the feature — a generated part takes its typed-in values only, and leaves the picked ones out`
  - `part 'Gear': 'teeth' must be at least 4, got 2`
  - `part 'Gear': 'Wide' names a configuration, and a generated part has none — insert it with its values, such as insert(def, { … })`
- A value of the wrong shape for any insert (`null`, an object) is refused by
  `insert()` itself, which fails the model's compile.
- **Lengths are the defining module's unit**, as a `part()` body's are; an
  assembly of another unit rescales the part. The values are not converted:
  `insert(gearPart, { width: 12 })` reads 12 in the part file's unit.
- A throw from `buildTool()` is a build error on the part's row.

## A part, by the part rules

The definition is a part: export it from the top level of a `*.part.js`
module (a package's `parts/`), and no two parts of one file share a name
(the name is `meta.name ?? meta.label`). Breaking either is a build error on
the `definePart()` call, as for `part()` ([[api/part]]).

Rendered on its own (the defining `*.part.js` open in the editor), the file
shows the part with every value at its default. A value that has no default
leaves one empty part saying so, at `definePart()`.

Its parts are engine-owned: material, appearance and name come from the
definition, and the editor refuses a write aimed at the part ("`'Gear' is
made by the generated part 'gear' (gear.part.js) and is read-only: change it
through the values of the insert that makes it.`"). The instance is the
assembly's own: its pose, grounding, name and mates are edited as any
instance's.

## In the editor

The assembly toolbar's **Custom** dropdown lists the definition under its
package (or the project), with its `icon` and `label`. Its cell, and its tile
in the Insert dialog, open the feature's dialog with no picks, drawing the
part as it will be while values change; **Apply** writes the import and
`const gear1 = insert(gearPart, { teeth: 18 }).name('gear1')` with only the
values the user changed. **Edit parameters…** on the instance opens the same
dialog on its values. See [[concepts/assemblies]].

## The schema

`getSchema()` is the definition as JSON: what the part catalog sends the
dialog (which never runs the code) and what a package's manifest carries
([[concepts/packages]]). `params` lists the values by id with resolved
defaults and labels, `layout` is always present, `connectors` names the
frames. Image paths resolve against two modules: `icon` against the
definition's (`'definition'`); option pictures and a value's `aside` against
the class's (`'class'`); `layout` and the dialog's `aside` against the one
`assetBase` names — `'definition'` when the metadata gives them, `'class'`
when they are borrowed from the feature dialog.

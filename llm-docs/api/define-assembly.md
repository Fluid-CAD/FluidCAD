---
id: api/define-assembly
title: "defineAssembly(GeneratorClass, meta) — a generator as an insertable sub-assembly, its values by id"
summary: "From fluidcad/sdk, exported from an *.assembly.js module: turns a Generator class (Generator.with({ … }), static id, layout(g), static build) into an assembly definition that insert() takes with the generator's values by id (insert(wardrobe, { drawers: 3 })) and returns an occurrence whose .parts is what layout(g) returned. meta: label (required; the assembly's name unless name), description, icon, layout (derived from the values when left out), width, aside, name; image paths relative to the defining module, may climb into the package; connectors is refused (an assembly's connectors are its parts'). A bad id, a refused value, a configuration name or a throw from layout(g) is a build error on the insert's row and leaves one empty part; a throw from build is one on that part's row. Rendered on its own, the defining file runs the layout at its root with every value at its default. The parts, mates and relations it makes are engine-owned and read-only; the occurrence is the assembly's own."
tags: [api, sdk, custom-feature, generated, assembly, type]
symbols: [defineAssembly, DefineAssemblyMeta, DefinableGeneratorClass, GeneratedAssemblyDefinition, LayoutResult]
seeAlso: [api/generator, api/define-part, api/insert, api/mate, api/relation, api/feature-layout, concepts/assemblies, concepts/custom-features, concepts/packages]
---

# defineAssembly

```ts
defineAssembly(GeneratorClass, meta: DefineAssemblyMeta): GeneratedAssemblyDefinition   // fluidcad/sdk, exported from an *.assembly.js module

type DefineAssemblyMeta = Omit<GeneratedMeta, 'layout'> & { layout?: FeatureLayout<P> };   // GeneratedMeta: api/define-part
//   label (required), description?, icon?, layout?, width?: 'wide' | 'wider', aside?, name?
type DefinableGeneratorClass = Generator.with() class & {
  id: string;                                                   // static id
  params: GeneratorParams;
  build(type: string, inputs: JsonValue, ctx: GeneratorBuildContext): Shape[];   // static build
};                                                              // and layout(g) on the prototype (api/generator)

class GeneratedAssemblyDefinition<T = LayoutResult<C>> extends Assembly<T> {   // what insert() takes, like an assembly() definition
  readonly generated: GeneratedMarker;   // { kind: 'assembly', id: <the generator's id> }
  getSchema(): GeneratedSchema;          // connectors: []; assetBase.layout: 'definition'
}
type LayoutResult<C> = the return type of C's layout(g)   // the occurrence's .parts

// In an assembly (api/insert):
insert(wardrobe, { drawers: 3 }): Occurrence<LayoutResult>   // values by id; occurrence.parts = what layout(g) returned
```

A generated assembly is a sub-assembly made by code: its parts, their
connectors, their starting poses and the joints between them come from a
generator's `layout(g)`, run with the values an `insert()` passes. Its values
are declared as a custom feature's are — types, defaults, ranges, options
with pictures, `visibleWhen` — and the editor opens the same kind of dialog
on them. The generator class itself is [[api/generator]].

## Example: a wardrobe

The generator class lives in `features/` (its values' option pictures
resolve against its module); the definition in `assemblies/`:

```js
// assemblies/wardrobe.assembly.js
import { defineAssembly } from 'fluidcad/sdk';
import { WardrobeUnit } from '../features/wardrobe-unit.js';

export const wardrobe = defineAssembly(WardrobeUnit, {
  label: 'Wardrobe',
  description: 'A wardrobe: the carcass, two hinged doors and drawers on runners',
  icon: '../features/icons/wardrobe.svg',
  width: 'wide',
  layout: [
    { row: ['width', 'height', 'depth'] },
    { section: 'Drawers', items: [{ row: ['drawers', 'drawerHeight'] }] },
    { section: 'Doors', items: ['hingeAngle', 'doorsOpen'] },
  ],
});
```

A bedroom assembly inserts it, places the occurrences and mates to their
parts through `occurrence.parts` — what the layout returned:

```js
// bedroom.assembly.js
import { assembly, insert, mate } from 'fluidcad/core';
import { wardrobe } from './assemblies/wardrobe.assembly.js';
import { storageBox } from './parts/storage-box.part.js';

export const bedroom = assembly('bedroom', () => {
  const left = insert(wardrobe, { drawers: 3 }).grounded().name('Left wardrobe');
  const right = insert(wardrobe, { drawers: 3 }).translate(1000, 0, 0).grounded().name('Right wardrobe');
  const box = insert(storageBox);
  mate('fastened', left.parts.carcass.connectors.top, box.connectors.base);   // a box on top of the left one
});
```

The two inserts are two occurrences of one definition with equal values:
they share every part template, so the carcass, each door and the drawer
build once for both (12 instances, 4 builds).

## What the class must be

`defineAssembly()` checks the class where the module loads and throws,
naming `defineAssembly(<Class>)`:

| The class | Message |
|---|---|
| not a `Generator.with()` class | `defineAssembly(): the first argument is the generator's class, one that extends Generator.with({ … }), got a function` |
| declares no values | `defineAssembly(Bare): Bare declares no values — declare them with Generator.with({ … }): class Bare extends Generator.with({ width: { type: 'length', default: 600 } })` |
| no `static id`, or a bad one | `defineAssembly(NoId): NoId needs a static id — the generator's type, such as 'cabinet'` / `the id 'acme cabinet' is not well formed — dot-separated names of letters, digits, '-' and '_', each starting with a letter, such as 'cabinet'` |
| no `layout(g)` | `defineAssembly(Cabinet): Cabinet implements no layout(g) — it declares the assembly's parts and joints: …` |
| no `static build` | `defineAssembly(NoBuild): NoBuild implements no static build(type, inputs, ctx) — it builds each part its layout declares: static build(type, inputs, ctx) { return [solid]; }` |

## The metadata

The same fields as `definePart`'s ([[api/define-part]]): `label` (required;
the assembly's name unless `name` is given), `description`, `icon`,
`layout`, `width`, `aside`, `name`. Image paths are relative to the
defining module and may climb out of its folder within the package
(`'../features/icons/wardrobe.svg'`).

- **`layout`** places the generator's values ([[api/feature-layout]]), each
  exactly once. Left out, it is derived from the values' `group` and `tab`.
- **`width`** (`'wide'`, `'wider'`) and **`aside`** (a size diagram beside
  the rows) dress the dialog as a feature's metadata does; left out, the
  dialog opens at the default width with no aside. Nothing is borrowed.
- Refused by name: `class`, `params` ("the values are the generator's own:
  declare them with Generator.with({ … })"), `call`, and `connectors` ("a
  generated assembly's connectors are its parts': g.part(type, { connectors
  }) in layout(g)"). Any other field is refused as unknown.

## Inserting it

`insert(wardrobe, { drawers: 3 })` takes the values **by id**, checked and
defaulted as a feature's call checks them, and returns an occurrence:

- **`occurrence.parts`** is what `layout(g)` returned: the handles the
  inserting assembly may mate to (`left.parts.carcass.connectors.top`,
  `left.parts.doors.left`, `left.parts.drawers[0]`). A handle the layout
  didn't return can't be reached.
- The occurrence is the inserting assembly's own: `.translate()`,
  `.rotate()`, `.grounded()`, `.name()`, `.transparent()`, deleting it, and
  Edit parameters on it.
- **Refusals are the insert's build error.** A name the generator doesn't
  take, a value its declaration refuses, a configuration name, and a throw
  from `layout(g)` leave the occurrence one empty part, named after the
  assembly, whose row says why, at the insert. Nothing else of that layout
  stays (no part, mate or relation). The rest of the assembly renders:
  - `assembly 'Wardrobe': 'widht' is not one of its values — did you mean 'width'? its values are width, height, …`
  - `assembly 'Wardrobe': 'drawers' must be at most 4, got 9`
  - `assembly 'Wardrobe': 'Wide' names a configuration, and a generated assembly has none — insert it with its values, such as insert(def, { … })`
  - `assembly 'Wardrobe': 4 drawers of 300 leave less than 600 for the doors of a wardrobe 1400 high` (the layout's own `throw`)
- **A throw from `static build`** is a build error on that part's row only,
  naming the build: `WardrobeUnit.build('door'): …`. The part holds no
  shapes; the other parts build.
- **Units.** The generator writes in its defining module's unit. Inserted
  into an assembly of another unit, its parts are rescaled and its poses,
  mate offsets, slider limits and rack ratios converted. The insert's values
  are not converted.
- A generated assembly is inserted into an assembly only; `insert()` in a
  part file is refused as for any definition.

Rendered on its own (the defining `*.assembly.js` open in the editor), the
file runs the layout at the assembly's root with every value at its
default. A value with no default, or a layout that throws, leaves one empty
part saying so, at `defineAssembly()`.

## Engine-owned rows

The parts a layout makes are no `part()` statements: the part rules don't
apply to them, and their rows — instances, mates and relations under the
occurrence — are read-only. The Parts panel offers Show in source on them;
the joints are driven from the Joints panel like any joint. A write aimed at
one is refused with "`'Left door' is made by the generated assembly
'wardrobe1' and is read-only: change it through the values of the insert
that makes it.`" Change them through the occurrence's values.

## In the editor

The assembly toolbar's **Custom** dropdown lists every generated part and
assembly, grouped by package; a generated assembly's tile in the Insert
dialog does the same. Either opens the dialog built from the schema: the
viewport shows the real result in its own appearance as values change (a
preview render, built at `'preview'` detail while a control moves and at
`'full'` once it rests), **Apply** writes the import and `const wardrobe1 =
insert(wardrobe, { … }).name('wardrobe1')`, and **Cancel** restores the
model. **Edit parameters…** on the occurrence's header opens the same dialog
on the insert's values and rewrites only those that changed. See
[[concepts/assemblies]].

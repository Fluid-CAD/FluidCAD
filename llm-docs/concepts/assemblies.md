---
id: concepts/assemblies
title: "Parts and assemblies — files, inserting, grounding, mating"
summary: "A .part.js file exports a part() with param() values, connector() mate frames and expose()d geometry; a .assembly.js file exports an assembly() whose body insert()s parts, .grounded()s one and mate()s the rest. Mates are solved live in the viewport. Units are the project's; parts are scaled in; overrides are in the part's unit. Generated definitions (definePart: a custom feature as a part; defineAssembly: a sub-assembly whose parts and joints a generator makes) are inserted with their values by id, from the assembly toolbar's Generate Parts dropdown with a live preview of the real result; the parts, mates and relations a generator makes are engine-owned, read-only rows of its occurrence."
tags: [concept, assembly, part, generated]
seeAlso: [api/part, api/param, api/connector, api/copy, api/expose, api/assembly, api/insert, api/mate, api/replicate, api/define-part, api/define-assembly, api/generator, concepts/units, concepts/global-parameters, concepts/configurations, concepts/custom-features, concepts/packages]
---

# Parts and assemblies

## File kinds

| suffix | scene | contents |
|--------|-------|----------|
| `.part.js` | part | modelling statements; optionally `export const x = part('X', () => { … })` |
| `.assembly.js` | assembly | `export const x = assembly('x', () => { insert(); mate(); … })` |
| `.fluid.js` | part | legacy suffix, same as `.part.js` |
| `.params.js` | — (never rendered) | `export const x = param('X', …)` project parameters every model imports ([[concepts/global-parameters]]) |

A `*.feature.js` file is not a model: it defines a custom feature that part
files import and call ([[concepts/custom-features]]). Custom features run in
part bodies and part files, never at the top level of an assembly file. What
an assembly inserts by code is a generated definition: a `definePart()`
export of a `*.part.js` or a `defineAssembly()` export of an `*.assembly.js`
(*Generated parts and assemblies*, below).

A part file renders every part it declares. Two rules hold for every
`part()`, in any file: it is **exported** — `export const x = part('X', …)`
at the top level of its file, never inside another body — and its **name is
unique within the file**. A part breaking either is a build error on its
`part()` call and does not build (see [[api/part]]); only an exported part
can be inserted elsewhere. Parts declared in other files (another part file, or an
installed package, [[concepts/packages]]) reach a scene only through
`insert()` in an assembly: importing from such a file does not by itself add its parts
to a part file. A new assembly file is scaffolded as one exported
`assembly()` definition; the UI writes inserts and mates inside its callback.

## A part's interface

| statement | in | out |
|-----------|----|-----|
| `param('Label', default, type?, opts?)` | `insert(def, { Label: value })` | the Part Parameters panel / Insert wizard controls |
| `connector('name', geometry)` | — | `instance.connectors.name` for `mate()` |
| `copy(…, name)` of that connector | — | `instance.connectors.name.instance(k)`, one per copy |
| `expose('name', sceneObject)` | — | `def.features.name` (another part), `instance.features.name` (tangent mate) |
| a generated definition's values | `insert(def, { id: value })` | its dialog (Generate Parts dropdown, Insert, Edit parameters) |

A dimension that must agree across parts (a wall thickness both halves of a
housing share, a bolt size) is not a part parameter overridden in every
`insert()`: it is a project parameter in `project.params.js`, imported by
each part (`import { wall } from "./project.params.js"`). An override that
names one is warned about, not applied. See [[concepts/global-parameters]].

A definition that comes in known variants declares them as named rows of
its parameters — `configurations({ Wide: { Width: 1200 } })`, the first
statement of the body — and a parent inserts one by name:
`insert(frame, "Wide")` or `insert(frame, "Wide", { Depth: 1000 })`. Never
copy a row's numbers into an override object. See
[[concepts/configurations]].

Connectors and exposures must be declared directly in the part body. A
connector is a frame (origin, X, Z) derived from a face (centre + outward
normal), a circular edge (centre + axis), a straight edge (midpoint +
tangent), an anchored vertex or a plane; `.offset()` and `.rotate()` move it
in its own axes.

A hole pattern needs one connector, not one per hole: declare it on the
first hole and `copy()` it — `copy(holes, bolt)` follows the repeat that
cut the holes, `copy('circular' | 'linear', …, bolt)` patterns it on its
own. Copy k of `bolt` is `instance.connectors.bolt.instance(k)`, a mate side
like any other; copies are read-only (edit the seed or the copy statement),
and `repeat()` refuses connectors. See [[api/connector]] and [[api/copy]].

## Workflow

1. `insert(def)` each part; chain `.translate()` / `.rotate()` for a starting
   pose and `.name()` for a label.
2. `.grounded()` exactly one instance per mechanism — the frame everything
   else is solved against.
3. `mate(type, a, b)` the rest. The first side drives; the second connector
   is placed face-to-face on it by default (`.flip()` for the other way),
   spun with `.rotate(deg)`, shifted with `.offset(x, y, z)`, bounded with
   `.limits(min, max)`.
4. `replicate(seed, targets, rows)` to copy a mated part onto new targets —
   one row per replica, e.g. `[base.connectors.hole.instance(1)]` for each
   copy of the plate's `hole` connector (the dialog's *Suggest copies* fills
   them).

Mates are solved in the viewer, live. The server's render places parts
where the source puts them; the mated layout is what the viewport shows and
what the viewer's Export writes. `get_scene_summary` lists every instance
under `instances` with that statement pose, the one `interfere`, `measure`
and `resolve_selection` use; no tool reports the solved pose. Its `mates`
and `relations` list the joints as written — type, name, both sides by
instance and connector, flip / rotate / offset / limits, the coupled mates
— with no solve status ([[concepts/scene-graph]]).

## Sub-assemblies and connectors

`assembly()` definitions nest: `insert(sub)` returns an occurrence whose
`.parts` is the body's return value, so deep references
(`occ.parts.arm.connectors.pivot`) bind to that occurrence. `.grounded()`
inside a body anchors within that body's frame; the parent grounds the
occurrence to pin it for real.

`connector('name', [x, y, z])` at an assembly file's top level is a free
frame — a mate side that belongs to no part, root scope only. `copy()` at
the same level patterns assembly connectors (and only them):
`copy('linear', 'x', { count: 4, offset: 50 }, bay)` makes `bay.instance(1)`
… `bay.instance(3)`, around or along a world axis or another assembly
connector. `repeat()` and solid copies stay inside parts.

## Generated parts and assemblies

A generated definition is inserted like any other, with its values **by
id**:

```js
const pinion = insert(gearPart, { teeth: 18, module: 1.5, width: 12 });   // definePart: an Instance
mate("revolute", plate.connectors.pinionShaft, pinion.connectors.axis);
const unit = insert(wardrobe, { drawers: 3 }).grounded().name("wardrobe1");   // defineAssembly: an Occurrence
mate("fastened", unit.parts.carcass.connectors.top, box.connectors.base);
```

- **A generated part** (`definePart`, [[api/define-part]]) is a custom
  feature built as a part: its connectors are the feature's frames
  (`pinion.connectors.axis`). It is one instance, mated like any.
- **A generated assembly** (`defineAssembly`, [[api/define-assembly]]) is an
  occurrence whose parts, connectors, starting poses and joints its
  generator's layout makes ([[api/generator]]): the wardrobe's carcass
  grounded inside it, its doors on revolute joints, its drawers on sliders.
  `occurrence.parts` is what the layout returned. Its joints are real mates
  inside the occurrence: the Joints panel lists them by name ("Left door")
  and animates them; the solver drives them like any.
- **The values are checked by the definition.** A misspelt id, a refused
  value, a configuration name (generated definitions have none) or a
  layout's refusal is a build error on the insert's row; the occurrence is
  then one empty part named after the definition, and the rest of the
  assembly renders.
- **Engine-owned rows.** The parts, mates and relations a generator makes
  are rows of its occurrence that no statement of the file wrote: they are
  read-only (the Parts panel offers Show in source; a write is refused with
  "… is made by the generated assembly 'wardrobe1' and is read-only: change
  it through the values of the insert that makes it."; `get_scene_summary`
  marks them `engineOwned: true`, mates and relations with the
  occurrence's path and name as `owner` / `ownerName`). The occurrence
  itself — its pose, grounding, name, deletion, mates to its parts — is the
  file's. A generated part's own material, appearance and name come from
  its definition; its instance is the file's.
- Equal values share builds: two inserts of one definition with equal values
  build each part once.

**In the editor.** The assembly toolbar's **Generate Parts** dropdown lists every
generated part and assembly of the project and its packages, grouped by
package; the Insert dialog shows them as tiles too. Either opens the
definition's dialog — the feature dialog's rows, sections and pictures,
with no picks:

- while values change, the viewport shows the **real result**, opaque and in
  its own appearance, joints included (a preview render of the code Apply
  would write, never written; a control being dragged renders at
  `'preview'` detail, then `'full'` once it rests);
- while the preview shows, the Parts, Joints and Connectors panels are
  read-only;
- **Apply** writes the import and `const wardrobe1 = insert(wardrobe, {
  drawers: 3 }).name('wardrobe1');` with only the values the user set; the
  render that follows reuses what the preview built;
- **Cancel** restores the model as it was.

**Edit parameters…** on a generated occurrence's header (or a generated
part's instance) opens the same dialog on the insert's values; Apply
rewrites the values that changed, Cancel restores the model.

## Units

An assembly never calls `unit()`. Its own lengths (translate, mate offsets
and limits) are in the **project unit**; inserted parts are built in their
file's unit and scaled into it, connectors included; `insert(def, { Length:
10 })` is read in the **part's** unit. A generated assembly is written in
its defining module's unit: its parts are rescaled and its poses, mate
offsets and slider limits converted; its insert values are not. See
[[concepts/units]].

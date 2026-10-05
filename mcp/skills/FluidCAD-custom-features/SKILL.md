---
name: FluidCAD-custom-features
description: "Writing custom features for FluidCAD: a feature type of the project's own in a `*.feature.js` module (`fluidcad/sdk` — `Feature.with()`, `defineFeature()`, `buildTool()`, `setBuckets()`, pickers, call shapes, `fluidcad/sdk/kernel`, raw OpenCascade through `fluidcad/sdk/occt`) that the toolbar's Custom dropdown offers with its own dialog and preview, and that models call like a built-in. Use this skill whenever the user wants a custom feature, their own feature type or toolbar button, a reusable feature, a `.feature.js` file, `fluidcad/sdk`, `Feature`, `defineFeature` or `registerBuilder`, or asks to turn a construction they keep repeating into one statement. Trigger it alongside the FluidCAD skill any time the FluidCAD MCP tools (`mcp__FluidCAD__*`) are available and a feature type, not a part, is being written."
---

Provenance: maintained in the FluidCAD repo (`https://github.com/Fluid-CAD/FluidCAD`), under `mcp/skills/`. The installed local skill files are the runtime source of truth.

# Writing a custom feature

This skill layers on top of the **FluidCAD** skill. That one owns the loop: read the docs, plan in generic CAD terms, build in increments, check `render.state` and `objectErrors`, resolve filters before writing them, screenshot when a feature earns it, and report only what was checked. Follow it for the test part. This skill covers what is specific to a custom feature: deciding that one is warranted, designing it as a feature a user fills in, writing the module, and proving it in a part.

The governing principle: **a custom feature is a CAD feature first and code second.** Its user picks a face and types a height in a dialog, then fillets its rim and repeats it; design for that user, write the code to that design, and prove it the way that user will use it.

## 1. Decide whether one is warranted

Write a custom feature when one construction recurs (across models, or across places in a model with different values) and should be **one statement, one dialog, one timeline row**: a PCB standoff on any face, a ring of clearance holes around any axis, a vent grid on any panel, bosses at a set of connectors.

Don't write one, and say why, when:

- the geometry occurs once: write the statements in the model;
- it is the same geometry again in one model: `repeat()` re-applies a feature at new positions, `copy()` duplicates a finished shape;
- it is a whole part reused with other dimensions: a `part()` with `param()` values, inserted where needed (the **FluidCAD-assembly** skill);
- a built-in already does it (`hole()` for drilled, clearance, tapped, counterbored and countersunk holes; `draft()`; `rib()`; `shell()`): search the docs first.

## 2. Design it in CAD terms

Before code, write the design down the way a CAD user would describe a feature dialog, and show it (under the autonomous fallback, put it in the report):

- **Name and id.** A label for the toolbar ("Vent grid") and a namespaced id (`acme.ventGrid`; take the namespace from the user or the project, else `acme`). The id is the feature's type in every timeline: pick it once.
- **What it does to the solids.** Adds material, cuts it, or keeps a separate body: that is a **tool** (`buildTool()` returns solids, the base fuses or cuts them) with `operations`. Changes existing solids in another way (tilts faces, offsets, splits): a **modifier** (`build()`); prefer a tool whenever the feature adds or removes material — the modifier surface is the engine's internals, not a settled SDK.
- **Operations and the default.** `['add', 'new']` for a boss-like feature, `['remove']` for a cut-only one (it cuts with no chain and shows no tabs), `['remove', 'new']` for a pocket that may also be a separate body. The default is `add` when offered, else the first listed.
- **Each value, as a dialog row.** Typed in: `length` (in the model's unit), `angle` (degrees), `integer`, `number`, `boolean`, `select`, `text`, with a `min`/`max` that keep the geometry valid. A row left alone in the dialog builds what it shows: a `boolean` without a `default` is off, a `select` without one takes its first option (an `optional` one stays unset, shown as "—"); a number or a text without one must be typed in (Apply says "Height is required."), so give every size a sensible `default`. Picked: `face`, `edge`, `axis` (takes world axes, axis statements, straight edges and connectors), `plane`, `sketch`, `solid`, `feature`, `connector`, `point`, `anchor`, or a union of kinds that take different clicks. One pick or a list (`multiple: true`). Group rows, put rarely used ones on a second tab, hide rows that only matter for one choice (`visibleWhen`).
- **The call a model writes.** Picked geometry first and positional, sizes in one object of options: `ventGrid(panel.endFaces(), { rows: 4, columns: 6, pitch: 8 })`. A list of picks is one array argument or a trailing rest.
- **The buckets.** Which faces of the result are its start faces (where it meets what it grew from), end faces (its far end), side faces, internal faces (bores, a cut's walls) and cap faces. A downstream fillet and every pick on the feature read these; without them `f.endEdges()` names nothing. For a cut, the plane the tool starts on (`startPlane`) classifies the rims.
- **The preview.** A tool previews by default by running `buildTool()`; one that takes over 1.5 s to build is paused in the dialog. Keep the build cheap, or override `ghost()` with a cheaper shape.
- **Can the curated kernel build it?** `fluidcad/sdk/kernel` has cylinders, spheres, cuts and placement transforms. Anything else (a box, a loft, a sweep, an offset) needs raw OpenCascade inside `this.occ()`: say so in the design, since it is unstable and unchecked.

## 3. Read the docs

`read_doc` these before writing (in parallel sub-agents when your client has them; sub-agents read, never write):

- `concepts/custom-features` — the module, discovery, the lifecycle, where errors show;
- `api/feature` — the class, `buildTool()`, `setBuckets()`, the reference readers, `ghost()`;
- `api/define-feature` — the metadata, operations, the call shape, what the dialog can edit;
- `api/feature-params` — every value kind, picker and option, unions;
- `api/sdk-kernel` — the geometry, and who owns which shape;
- `api/sdk-occt` — only when the design needs raw OpenCascade;
- `api/register-builder` — only when the builder must act before it reads its arguments.

`get_type_definition` resolves `Feature`, `FeatureBuckets`, `ParamSpec`, `CallShape`, `FeatureMeta`, `OccScope` and the kernel classes; `get_api_signature` resolves `defineFeature`, `registerBuilder`, `parseCall` and `getOC`. Then read `references/traps.md` in this skill.

## 4. Write the module

One file, `<name>.feature.js`, anywhere in the workspace except under node_modules, a dot directory or a gitignored path; beside the models that use it is the norm. The suffix is what the editor scans for, and it keeps the module's own stack frames out of the statement's source location. The shape:

```js
import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

export class VentGrid extends Feature.with({
  face: { picker: 'face', label: 'Panel face', surface: 'planar' },
  rows: { type: 'integer', default: 3, min: 1, max: 50 },
  // …
}) {
  static id = 'acme.ventGrid';

  buildTool() {
    const { rows } = this.values;              // typed: a number
    const [face] = this.facesOf(this.values.face);
    // Build on the XY plane, sort the faces into buckets there, place with
    // ShapeOps.transformTracking, name the placed images, dispose what you drop.
    this.setBuckets({ /* startFaces, endFaces, sideFaces, internalFaces, startPlane */ });
    return [/* the solids */];
  }
}

export const ventGrid = defineFeature(VentGrid, {
  label: 'Vent grid',
  description: 'A grid of round vent holes through a panel',
  group: 'create',
  operations: ['remove'],
  call: ['face', { rows: 'rows' /* , … */ }],
});
```

The rules that keep it right:

- **Export the builder by name.** A default export is skipped by the editor's scan.
- **No constructor, no module-level state, no geometry at module level.** The module is evaluated anew on every render and by the editor's scan, so the class is new each time: never `instanceof` it. The engine compares features by id and values.
- **Read references only through the helpers:** `facesOf`, `edgesOf`, `shapesOf`, `axisOf`, `planeOf`, `frameOf`, `pointOf`, `isLocation`. The preview hands the feature stand-ins, not the scene's objects.
- **Validate the picks and values the metadata can't**, and throw a message that names the feature and the fix (`vent grid: the holes (6) must be narrower than the pitch (5)`): `surface: 'planar'` only limits the dialog's picks, never a hand-written call.
- **Build tools on the XY plane** (start at `z = 0`), sort their faces into buckets there, then place them with `ShapeOps.transformTracking` and name the images it returns.
- **Dispose every intermediate** (a cylinder a cut consumed, a shape you moved); never dispose a shape `buildTool()` returns or one read from a reference.
- **A loop inside `buildTool()` is fine**: the instances come from one statement and one row. The no-loops rule is for models.
- **Raw OpenCascade only inside `this.occ(({ oc, track }) => …)`**: construct through the scope's `oc`, `track()` every object a method returns, return wrappers made with `ShapeFactory.fromShape(raw)`. Never construct through `getOC()`, never free a shape the scene holds.

**Writing it with the MCP.** `write_file` on a `*.feature.js` (or any module, or `fluidcad.json`) never renders the module itself: it re-renders the **open model** in full, and `render` carries `openModel: true` with that model's `state` and `objectErrors`. So write the module, then write the test part (which renders and becomes the open model); from then on, every module write reports on the test part. `render.state` of `no-open-model` means no model is open yet; `render-failed` carries the first lines of the error the model hit loading the module (a refused metadata field, a syntax error), and `get_compile_error` has the whole message with the module's line a moment later.

## 5. Write a test part that uses it the way a user would

A recognisable part (a panel, a bracket, a PCB plate), built by the FluidCAD skill's rules: imports from every entry it uses (`import { ventGrid } from './vent-grid.feature.js'`), named dimensions, fully constrained sketches. Exercise what a user will do:

- the feature on a picked face written as an accessor (`panel.endFaces()`), as the dialog would write it;
- each operation it offers, and `.scope(…)` when it matters;
- a `repeat()` or `copy()` of the feature, when its use calls for patterns;
- a fillet or chamfer on its buckets (`fillet(0.5, post.endEdges())`), and a downstream feature on one of its faces;
- values at their limits (the smallest count, a value left to its default).

## 6. Render and check

1. **`render.state` and `objectErrors`.** Where each failure shows:
   - a refused metadata field, a syntax error in the module, or a call the builder can't read (`ventGrid(): 'rows' must be at least 1, got 0`) fails the **whole model** to compile: `compile-error` on the model's write, `render-failed` on the module's;
   - `buildTool()` throwing, returning nothing, or an operation the feature doesn't offer fails **its row** only: `build-error`, with the message under `objectErrors`.
2. **`validate`** every solid the feature made, then `screenshot` it (a section through a cut feature) and `measure` the dimensions its values drive: a hole's diameter, a boss's height, a pitch between two instances.
3. **The buckets resolve.** Find the feature's scene-object `id` and `index` with `get_scene_summary`, then `resolve_selection` the expression `$obj["<id>"].startEdges()` (and each other bucket you declared), scoped to its part, with `before` set to the index right after the feature: a later fillet or chamfer replaces the edges and faces it touches, so at the model's end those buckets resolve to nothing. The count must be what the design says (a 3 × 5 vent grid: 15 start edges, 15 end edges, 15 internal faces), and the summaries' centres and diameters must sit where the values put them. Zero means `setBuckets()` missed them, or named faces of a shape the feature doesn't return.
4. **A value change rebuilds.** Change one value in the test part and confirm the geometry follows; `render.changes.rebuilt` lists the feature's row.
5. **It typechecks** under the workspace's `jsconfig.json` (`fluidcad init` writes one with `checkJs`): when you have a shell, `npx -p typescript tsc --noEmit -p jsconfig.json` in the workspace, expecting no errors. `this.values` and the builder's arguments are typed by inference; a misspelled option in the test part is an error.
6. **The editor offers it.** When you have a shell, `GET http://localhost:<port>/api/features/catalog` (the port from `list_workspaces`) lists the feature with no `error`; an `error` is what the Custom dropdown's greyed cell says.

## 7. Iterate

Saving the module's code rebuilds its statements in every model that read it, with no engine restart; with the MCP, the module write re-renders the open model in full and reports on it. Change one thing per write. When a value change misbehaves but a fresh write is right, suspect state kept between renders.

## 8. Report only what was checked

Report the design (section 2), what you rendered, validated, measured and resolved, and the typecheck and catalog results. Name what you did not check: the dialog and its preview are only seen in the FluidCAD UI, so unless a browser drove them, say "not checked in the dialog" rather than implying it. Tell the user where the feature appears (the toolbar's **Custom** dropdown, last on the part toolbar) and that a model imports it from the module.

## Quick reference: the custom-feature loop

1. Decide that a feature is warranted, or say what to use instead (section 1).
2. Design it in CAD terms: tool or modifier, operations, each value as a dialog row, the call, the buckets, kernel or raw OpenCascade (section 2). Show it.
3. `read_doc` the custom-feature docs; read `references/traps.md`.
4. `write_file` the `*.feature.js` module.
5. `write_file` a recognisable test part that uses it as a user would.
6. `render.state`, `objectErrors`, `validate`, `screenshot`, `measure`, `resolve_selection` on its buckets; typecheck and the catalog when a shell is available.
7. Iterate on the module: each write re-renders the open model (`render.openModel`).
8. Report what was checked, and what was not.

---
name: FluidCAD-custom-features
description: "Writing custom features for FluidCAD: a feature type of the project's own in a `*.feature.js` module (`fluidcad/sdk` — `Feature.with()`, `defineFeature()`, `buildTool()`, `setBuckets()`, pickers, call shapes, `fluidcad/sdk/kernel`, raw OpenCascade through `fluidcad/sdk/occt`) that the toolbar's Custom dropdown offers with its own dialog and preview, and that models call like a built-in. Use this skill whenever the user wants a custom feature, their own feature type or toolbar button, a reusable feature, a `.feature.js` file, `fluidcad/sdk`, `Feature`, `defineFeature` or `registerBuilder`, asks to turn a construction they keep repeating into one statement, or wants to share custom features as a package (`fluidcad.json` `package` block, the `pack` tool). Trigger it alongside the FluidCAD skill any time the FluidCAD MCP tools (`mcp__FluidCAD__*`) are available and a feature type, not a part, is being written."
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

- **Name and id.** A label for the toolbar ("Vent grid") and a plain id (`ventGrid`). It may not be one of the engine's own types (`extrude`, `fillet`, `part`, `sketch`, `distance`, …: "'extrude' is one of the engine's own types: give the feature another id"). The id is the feature's type in every timeline: pick it once. Installed from a package, the feature's type becomes `@<handle>/<package>:ventGrid` (what `get_scene_summary` shows); a model still imports and calls `ventGrid`, and never writes that key.
- **What it does to the solids.** Adds material, cuts it, or keeps a separate body: that is a **tool** (`buildTool()` returns solids, the base fuses or cuts them) with `operations`. Changes existing solids in another way (tilts faces, offsets, splits): a **modifier** (`build()`); prefer a tool whenever the feature adds or removes material — the modifier surface is the engine's internals, not a settled SDK.
- **Operations and the default.** `['add', 'new']` for a boss-like feature, `['remove']` for a cut-only one (it cuts with no chain and shows no tabs), `['remove', 'new']` for a pocket that may also be a separate body. The default is `add` when offered, else the first listed. `buildTool()` reads the operation its statement applies — the chain's, else the default; the dialog's tab in the preview; the statement's on a repeat's copy — with `this.getOperationMode()` (`'add'`, `'new'` or `'remove'`), when a remove needs a different tool than an add (an internal gear adds the whole ring but removes only the tooth space).
- **Each value, as a dialog row.** Typed in: `length` (in the model's unit), `angle` (degrees), `integer`, `number`, `boolean`, `select`, `radio`, `text`, with a `min`/`max` that keep the geometry valid. A row left alone in the dialog builds what it shows: a `boolean` without a `default` is off, a `select` or a `radio` without one takes its first option (an `optional` one stays unset), a slider without one sits at its `min`, a select with `multiple: true` is `[]`; a number or a text without one must be typed in (Apply says "Height is required."), so give every size a sensible `default`. Picked: `face`, `edge`, `axis` (takes world axes, axis statements, straight edges and connectors), `plane`, `sketch`, `solid`, `feature`, `connector`, `point`, `anchor`, or a union of kinds that take different clicks. One pick or a list (`multiple: true`). Hide rows that only matter for one choice (`visibleWhen`), or for one kind of pick (`visibleWhen: { at: { not: { surface: 'cylinder' } } }` hides a hub's rows while a shaft is picked).
- **The control for each typed-in value.** `type` is what the value is; `display` and the fields beside it are only how its row looks, and never change the statement. Choose by what the user is deciding:
  - a few choices, all worth seeing at once: `radio` — `display: 'buttons'` for 2–3 short labels, `'cards'` when pictures tell them apart;
  - many choices: `select` — `display: 'grid'` with an `image` per option when they are recognised by shape, `search: true` beyond a dozen;
  - several at once: `select` with `multiple: true` (the value is a list; `min`/`max` count it);
  - a bounded number the user explores: `display: 'slider'` (needs `min` and `max`); a small count: `display: 'stepper'` (`number`/`integer` only); a unit: `suffix: 'mm'`; a remark that must stay visible: `hint` (`description` is the tooltip);
  - one choice narrows another (the sizes of the chosen standard): one select whose options carry `when: { standard: 'iso' }`, not two selects swapped with `visibleWhen`. `when` narrows the dialog only — a hand-written call may pass any declared option, so the builder must handle every one;
  - images are files next to the module (`'./vent/slots.svg'`), drawn as pictures: use mid-tone strokes, not `currentColor`.
- **The layout, only when it earns it.** A handful of rows needs none: declaration order is the dialog, with a value's `group` and `tab` as the short form. Write a `layout` (with `width: 'wide'` when rows sit side by side) when values pair up in a `row` (count and spacing), a rarely used set should fold (`{ section, collapsed: true }`), or a dimension drawing belongs in the `aside`. A value that measures something the user may not know (a pressure angle, a profile shift, a backlash) earns an `aside` of its own — a diagram and a one-line note the card shows while its row has the focus. Rows never cut a label short: a cell that can't fit wraps to its own line, so pair narrow controls and give a long segmented choice (or a select) its own line. A layout places every value exactly once, and then no value may keep its own `group` or `tab`.
- **The call a model writes.** Picked geometry first and positional, sizes in one object of options: `ventGrid(panel.endFaces(), { rows: 4, columns: 6, pitch: 8 })`. A list of picks is one array argument or a trailing rest. A pick that may be left out (`optional: true`, a placement that defaults to the origin) stays first: a call without it goes straight to the options, `gear({ teeth: 24 })` (never `gear(undefined, …)`), and the dialog writes it that way.
- **The buckets.** Which faces of the result are its start faces (where it meets what it grew from), end faces (its far end), side faces, internal faces (bores, a cut's walls) and cap faces. A downstream fillet and every pick on the feature read these; without them `f.endEdges()` names nothing. For a cut, the plane the tool starts on (`startPlane`) classifies the rims.
- **The preview.** The dialog's **Preview** toggle starts off (remembered per feature once the user turns it on); while it is on, a tool previews by running `buildTool()` on every change, and one that takes over 5 s to build times out (the user turns the toggle off and on to ask again). Keep the build cheap, or override `ghost()` with a cheaper shape; `ghost: false` removes the toggle.
- **Can the curated kernel build it?** `fluidcad/sdk/kernel` has cylinders, spheres, cuts and placement transforms. Anything else (a box, a loft, a sweep, an offset) needs raw OpenCascade inside `this.occ()`: say so in the design, since it is unstable and unchecked.

## 3. Read the docs

`read_doc` these before writing (in parallel sub-agents when your client has them; sub-agents read, never write):

- `concepts/custom-features` — the module, discovery, the lifecycle, where errors show;
- `api/feature` — the class, `buildTool()`, `setBuckets()`, the reference readers, `ghost()`;
- `api/define-feature` — the metadata, operations, the call shape, what the dialog can edit;
- `api/feature-params` — every value kind, picker and option, unions; each `display`; the table of what an untouched row shows and the builder gets; a runnable example with every control ("a screw hole with choices");
- `api/feature-layout` — only when the design has a `layout`, `width`, an `aside` or a value's own `aside`;
- `api/sdk-kernel` — the geometry, and who owns which shape;
- `api/sdk-occt` — only when the design needs raw OpenCascade;
- `api/register-builder` — only when the builder must act before it reads its arguments.

`get_type_definition` resolves `Feature`, `FeatureBuckets`, `ParamSpec`, `ChoiceOption`, `FeatureLayout`, `CallShape`, `FeatureMeta`, `OccScope` and the kernel classes; `get_api_signature` resolves `defineFeature`, `registerBuilder`, `parseCall` and `getOC`. Then read `references/traps.md` in this skill.

## 4. Write the module

One file, `<name>.feature.js`, anywhere in the workspace except under node_modules, a dot directory or a gitignored path; beside the models that use it is the norm. The suffix is what the editor scans for, and it keeps the module's own stack frames out of the statement's source location. The shape:

```js
import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives, ShapeOps } from 'fluidcad/sdk/kernel';
import { Matrix4, Plane } from 'fluidcad/math';

export class VentGrid extends Feature.with({
  face: { picker: 'face', label: 'Panel face', surface: 'planar' },
  rows: { type: 'integer', display: 'stepper', default: 3, min: 1, max: 50 },
  pitch: { type: 'length', display: 'slider', default: 8, min: 2, max: 40, suffix: 'mm' },
  // …
}) {
  static id = 'ventGrid';

  buildTool() {
    const { rows, pitch } = this.values;       // typed: numbers
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
  call: ['face', { rows: 'rows', pitch: 'pitch' /* , … */ }],
  // layout: ['face', { row: ['rows', 'pitch'] }, …], width: 'wide'   — only when the design calls for one
});
```

Every value the class declares must appear in `call` (and in the `layout`, when there is one). A complete module with every control and a layout is the screw hole in `api/feature-params`.

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

- every argument as the dialog writes it: a select, radio or text as a plain literal, a `multiple: true` select as an array literal (`finishes: ['deburr']`, `[]` for none);
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

## 8. Package it, when it should travel

Do this only when the user wants the feature in other projects or for other people; a feature used in its own workspace needs no package. A package is the workspace's own `fluidcad.json` with a `package` block, packed into one `.fluidpkg` file that `fluidcad publish` uploads to the hub (`read_doc concepts/packages`). Packages reach other projects only through the hub: the archive itself never installs.

1. **The layout.** The folders decide what a package exports: every `*.feature.js` in `features/`, every `*.part.js` (or `*.fluid.js`) in `parts/` and every `*.assembly.js` in `assemblies/`, nested folders allowed. Move each feature module into `features/` with its images (they resolve next to the module, so `./vent-grid.svg` keeps working), and a part or assembly that should travel into `parts/` or `assemblies/`; its imports become relative to the folders (`import { ventGrid } from '../features/vent-grid.feature.js'`). Plain `.js` helpers can sit in any of the three, never at the root: pack refuses an import that leaves them (`outside-layout`) and a module in the wrong folder for its suffix (`wrong-folder`). A test part that should not travel stays outside the three folders, at the root, and imports `./features/vent-grid.feature.js`. A package needs at least one part or assembly to be published on the hub; a features-only package still packs, but can't be published.
2. **The block.** The name is `@<handle>/<name>`, where the scope is the user's hub handle: ask them, or run `npx fluidcad whoami`. With a shell, `npx fluidcad package init --name @<handle>/vent-hardware` in the workspace writes it: the name and version `0.1.0`, and it says what the folders hold (signed in, `--name vent-hardware` takes their handle and says so). Without one, add it to `fluidcad.json` with `write_file`, keeping every other key (`engine`, `unit`, `materials`):
   ```json
   "package": {
     "name": "@acme/vent-hardware",
     "version": "0.1.0",
     "description": "A vent grid for enclosure panels"
   }
   ```
   Packages are named @handle/name, each part in lowercase letters, digits and single dashes, starting with a letter. A name without the scope (`vent-hardware`) is refused, and the scope must be the handle they publish under: `fluidcad publish` refuses another one. Feature ids stay plain. There is no `exports` key: a block that has one is refused.
3. **`pack`** with `saveAsPath` set to an absolute path named as the result's `fileName` (`acme-vent-hardware-0.1.0.fluidpkg`), outside the workspace unless the user asked for it there. The engine evaluates every export and builds every part and assembly first; `pack-refused` carries one sentence naming the file and a `details.code` (`wrong-folder`, `outside-layout`, `no-exports`, or `refused` for a name without its scope, two features sharing an id, a missing image, an import from node_modules or another package, a part that fails to build, unsaved editor changes). Fix that file and pack again.
4. **Report** the package name, version, `savedTo` and what it holds (the result's `contents`: the features, parts and assemblies by folder). Tell the user how it reaches other projects: only through the hub. `npx fluidcad publish` uploads it (it needs a hub handle and publishing rights, and an admin reviews it before it is public); then, in another project, `npx fluidcad install @acme/vent-hardware` installs it and a model imports it by that name (`import { ventGrid } from '@acme/vent-hardware'`). The archive itself doesn't install. To try the package, use its features and models in this workspace. Never publish or install on the user's behalf.
5. **A new version:** edit the module, raise `package.version` (`npx fluidcad version minor`, or edit the block), and `pack` again. An installed version never changes, so a fix to a released version is always a new version.

## 9. Report only what was checked

Report the design (section 2), what you rendered, validated, measured and resolved, and the typecheck and catalog results. Name what you did not check: the dialog and its preview are only seen in the FluidCAD UI, so unless a browser drove them, say "not checked in the dialog" rather than implying it. Tell the user where the feature appears (the toolbar's **Custom** dropdown, last on the part toolbar) and that a model imports it from the module.

## Quick reference: the custom-feature loop

1. Decide that a feature is warranted, or say what to use instead (section 1).
2. Design it in CAD terms: tool or modifier, operations, each value as a dialog row, the call, the buckets, kernel or raw OpenCascade (section 2). Show it.
3. `read_doc` the custom-feature docs; read `references/traps.md`.
4. `write_file` the `*.feature.js` module.
5. `write_file` a recognisable test part that uses it as a user would.
6. `render.state`, `objectErrors`, `validate`, `screenshot`, `measure`, `resolve_selection` on its buckets; typecheck and the catalog when a shell is available.
7. Iterate on the module: each write re-renders the open model (`render.openModel`).
8. When it should travel: the modules into `features/`, `parts/` and `assemblies/`, the `package` block in `fluidcad.json`, then `pack` with `saveAsPath` (section 8).
9. Report what was checked, and what was not.

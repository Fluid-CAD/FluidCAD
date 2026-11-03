# Generated parts and assemblies

Read before writing `definePart`, `defineAssembly` or a `Generator`. The API is in `read_doc api/define-part`, `api/feature-frames`, `api/generator` and `api/define-assembly`; this file is the workflow, the rules and the checks.

## Which one

The values a feature declares are the interface of three hosts (`read_doc concepts/custom-features`, *One schema, three hosts*):

- **A feature** (`defineFeature`): an operation in a part body — a boss on a face, holes round an axis.
- **A generated part** (`definePart(FeatureClass, meta)` in a `*.part.js`): a part one feature builds and an assembly inserts and mates — a gear, a bushing, a screw. The feature keeps working in part bodies; the part adds no code of its own beyond the frames.
- **A generated assembly** (`defineAssembly(GeneratorClass, meta)` in an `*.assembly.js`, over a class that extends `Generator.with({ … })`): several parts that move against each other, sized from one set of values — a wardrobe's carcass, doors and drawers; a gear train.
- **Neither**: a fixed set of parts with a few dimensions is an `assembly()` with `param()` values (the **fluidcad-assembly** skill).

Both generated kinds are inserted with values by id (`insert(gearPart, { teeth: 18 })`, `insert(wardrobe, { drawers: 3 })`) and appear in the assembly toolbar's **Custom** dropdown with the feature-style dialog. They take **values only**: no picks.

## Design first, in CAD terms

Write it down and show it, as for a feature:

- **The parts and what moves.** For a generator: each part type (carcass, door, drawer), which is grounded, each joint (revolute about a hinge axis, slider along a runner), its limits and the name the Joints panel will show ("Left door"). For a definePart: the frames the feature publishes and what a mate does with each (`axis`: origin on the axis, Z up it, X the phase reference).
- **Frames as the user will mate them.** Origin, Z, X for every connector, in the part's own coordinates. A frame should not move when a value only moves geometry along or about it (a gear's phase turns the teeth, never the `axis` frame).
- **Which parts are equal.** Equal inputs and connectors make one template built once (equal drawers); a mirror image needs other inputs (left and right doors).
- **What `'preview'` leaves out**: drilling, small hardware, fillets — what is slow and not needed to judge the size.
- **The values**, declared as a feature's (`read_doc api/feature-params`). Values that only set a starting pose (doors open, drawers out) are fine: they rebuild nothing.

## The rules

### definePart

- The class is a **tool** (`buildTool()`), declared with `Feature.with()`. A modifier, a remove-only feature, and a feature with a **required** pick are refused where the module loads. Make every pick `optional: true`; the part leaves it out, so `buildTool()` must build at the origin when the pick is `undefined` (`let base = Plane.XY(); if (face !== undefined) { … }`).
- **Frames become connectors.** Declare them on the class, `Feature.with(params, { frames: { axis: { label: 'Gear axis' } } })`, and set every one in every build with `this.setFrames({ axis: plane })` — a `Plane` (origin, X direction, normal) where the feature stands. Never in `defineFeature()`'s metadata (refused).
- Export it from the top level of a `*.part.js` (a package's `parts/`); its name (`meta.name ?? meta.label`) is unique in the file. The part rules apply as for `part()`.
- `meta`: `label` (required), `description`, `icon`, `layout`, `width`, `aside`, `name`. Leave `layout`, `width` and `aside` out to borrow the feature dialog's (less its picks). Image paths are relative to the `*.part.js` and may climb into the package (`'../features/icons/gear.png'`).

### Generator and defineAssembly

- **`Generator.with({ … })`** takes the same declarations as `Feature.with()`, typed-in only (a picker is refused). Declare `static id`; declare no constructor; read `this.values`.
- **`layout(g)` is plain synchronous JavaScript** run on every insert and every preview tick: no geometry, nothing slow. It declares parts (`g.part(type, { name, inputs, connectors, appearance, material })`), joints (`g.mate(type, a, b)` with `.flip()`, `.rotate()`, `.offset()`, `.limits()`, `.name()`) and couplings (`g.relation()`), and **returns the handles** the inserting assembly may mate to — that object is `occurrence.parts`. Loops are fine here.
- **`static build(type, inputs, ctx)` reads only `type` and `inputs`.** Whatever changes a part's geometry must be in its `inputs`. Never read `this`, module state or a closure over the layout's values. Return an array of kernel shapes at the part's own origin; raw OpenCascade goes inside `ctx.occ(({ oc, track }) => …)` (`read_doc api/sdk-occt`); dispose what you drop. Handle every type the layout declares and throw on any other.
- **Inputs are plain JSON**: finite numbers, strings, booleans, `null`, arrays, plain objects. Functions, class objects (a `Plane`, a `Map`), `undefined` and `NaN` are refused with their path. Round computed numbers (to 6 decimals) so two parts equal on paper share a template.
- **Connector frames are plain JSON**, `{ origin: [x, y, z], z: [x, y, z], x?: [x, y, z] }`, in the part's own coordinates.
- **The hinge pattern.** Give the grounded part a connector that is the same frame, in the assembly, as the moving part's own connector when closed, pose the part there, and `.flip()` the mate. The joint's 0 is then closed, and `.limits(0, angle)` / `.limits(0, travel)` read naturally. Face-to-face (no flip) turns the part over.
- **Poses are warm starts.** `.pose({ position, rotation })` sets where a part starts (rotation in degrees, X then Y then Z, about the part's origin); `.grounded()` fixes it in the occurrence's frame. The joints decide the rest.
- **Name every joint** (`.name('Left door')`): the Joints panel lists joints by name.
- Every length (values, inputs, frames, poses, offsets, slider limits, rack ratios) is the defining module's unit; the engine converts them for an assembly of another unit.
- **Where it lives.** The class in a plain module beside its images (a package's `features/`; option pictures resolve against the module that calls `Generator.with()`), shared code in `features/lib/`, the definition exported from an `*.assembly.js` (a package's `assemblies/`). `meta` takes `label` (required), `description`, `icon`, `layout`, `width`, `aside`, `name`; `connectors` is refused.
- **Never keep shapes in module state.** The engine caches builds across renders (by type, inputs, connectors, appearance, material, units, detail and code version); a shape the module kept may already be freed.

### Both

- Generated parts are **engine-owned**: their rows are read-only in the editor, and so are a generator's mates and relations. The insert's instance or occurrence is the assembly's own. Change the parts through the insert's values.
- No configurations: `insert(def, 'Wide')` is a row error.

## Writing it with the MCP

1. Write the feature or generator module (`write_file`). A plain `.js` module renders nothing itself: it re-renders the open model (`render.openModel: true`).
2. Write the defining file — `parts/gear.part.js` or `assemblies/wardrobe.assembly.js`. It renders the definition alone, every value at its default: a `*.part.js` the part at its origin, an `*.assembly.js` the layout at the assembly's root. Check `render.state === 'rendered'` and `objectErrors`.
3. Write a test assembly that inserts it the way a user would: values by id, a grounded or mated insert, a mate to one of its connectors (`pinion.connectors.axis`, `unit.parts.carcass.connectors.top`), a second insert with equal values (shared templates), values at their limits. For a package, keep it at the workspace root (outside the three folders).

## Verify

- **`render.state` and `objectErrors`.** Where each failure lands:
  - a bad declaration, a bad class or bad `meta` throws where the module loads: `compile-error` on the model's write (`render-failed` on a module write); `get_compile_error` has the message (`defineAssembly(WardrobeUnit): …`, `Generator.with(): 'face' is a picked value — …`);
  - a misspelt id, a refused value, a configuration name, a throw from `layout(g)`, a bad `g.part()` spec, frame or pose, non-JSON inputs: `build-error` with one `objectErrors` entry (`uniqueKind: 'part'`, named after the definition) at the **insert's line**, its message leading with the definition (`assembly 'Wardrobe': 'widht' is not one of its values — did you mean 'width'? …`, `part 'Gear': 'teeth' must be at least 4, got 2`); the occurrence is one empty part, nothing else of the layout;
  - a throw from `build`, or a result that is not an array of shapes: `build-error` on **that part's** row (`uniqueKind: 'part'`, named after its type, located at `defineAssembly()`), its message naming the build (`WardrobeUnit.build('door'): …`); the other parts build.
- **`get_scene_summary`:**
  - `occurrences`: one per generated-assembly insert (`name`, `assemblyName` = the definition's `name ?? label`);
  - `instances`: one per `g.part()` call, `owner` = the occurrence path (`asm-0`), `name` = the spec's `name`, `grounded` true for the grounded part; count them against the design;
  - `objects`: one `part` row per **template** (named after its type: `door`), `params.generatedBy: { definition, type }`, holding a `generated-part` row (its shapes) and, per connector, a frame row and a `connector` row named as declared. Fewer `part` rows than instances is template sharing at work (2 doors + 1 drawer template for 3 drawers). A definePart part row carries `params.generated: { definition, values }` and a `connector` row per frame;
  - mates and relations are not in the summary: check the joints with a `screenshot` (each part where its starting pose puts it), and tell the user to drive them from the Joints panel.
- **`validate`** the parts (scoped by `instanceId`) and **`interfere`** at the starting poses: with the hinge pattern the closed parts touch the carcass and clash with nothing. A clash between a drawer and the carcass is a wrong frame or input.
- **`measure`** the sizes the values drive (carcass width, a drawer front's height, a hinge cup's diameter), with `instanceId`. Statement poses are the layout's starting poses.
- **A value change** in the test assembly rebuilds only the templates whose inputs it touches: in `get_scene_summary` the other templates' `part` rows read `fromCache: true`; a pose-only value leaves every template `fromCache`.
- **The `'preview'` tier** runs only in the editor's dialog; the MCP renders `'full'`. Keep the preview branch to leaving things out, so the full build exercises every shape the preview makes. Say "preview tier not checked" unless a browser drove the dialog.
- **It typechecks** under the workspace's `jsconfig.json` when a shell is available (`npx -p typescript tsc --noEmit -p jsconfig.json`). Annotate as the packages do for completions: `/** @param {import('fluidcad/sdk').GeneratorLayout} g */`, `/** @param {string} type @param {import('fluidcad/sdk').JsonValue} inputs @param {import('fluidcad/sdk').GeneratorBuildContext} ctx */`.
- **`pack`** in a package workspace: the result's `contents.parts` / `contents.assemblies` list the definitions; pack builds each with its defaults. Refusals to expect: a declared image that doesn't exist, or leads out of the workspace (check 9); a `minEngine` below 0.0.49 ("… a generated assembly (defineAssembly), which FluidCAD 0.0.49 is the first to run. Set "minEngine" in the package block to 0.0.49 or later, then try again."); a definition in the wrong folder (`wrong-folder`). Warnings: `undocumented-fields` for a definition without a `description` and a generated assembly's values without one.

## Traps

- **A value in `build` that isn't in `inputs`.** Reading `this.values`, a module variable or a closure in `build` builds the first render right and serves stale shapes after: the cache keys on inputs. Put it in `inputs`.
- **Unrounded inputs.** `width / 3` on two doors that should match gives two templates 1e-13 apart: twice the builds. Round.
- **A `Plane`, a `Vector3d` or a class object in `inputs` or a frame.** Refused with its path (`inputs.frame is a Plane — inputs are plain JSON: …`). Pass `[x, y, z]` arrays.
- **Face-to-face hinge.** A revolute or slider without `.flip()` between two copies of one frame turns the moving part over. Flip it, or give the moving part's connector Z against the carcass's.
- **A required pick under `definePart`.** Refused where the module loads: make it `optional: true` and build at the origin without it.
- **A frame the build forgets to set** (a branch that returns early) fails the part with `gear: its build set no frame 'axis' — set it with this.setFrames({ axis: plane })`. Set every declared frame on every path.
- **The generator class in `features/lib/` with pictures in `features/img/`.** Option pictures resolve against the class's module, so pack looks in `features/lib/img/` and refuses. Keep the class beside its images.
- **Inserting by label.** `insert(wardrobe, { 'Drawer height': 200 })` is refused on the row; values go by id (`drawerHeight`).
- **Expecting configurations.** Generated definitions have none; offer the variants as values (a `select`).

---
name: FluidCAD
description: "Workflow and best practices for designing parts in FluidCAD through its MCP server. Use this skill whenever the user wants to model, design, build, edit, fix, or modify any part in FluidCAD, whenever they mention FluidCAD, a `.fluid.js` or `.part.js` file, or ask for CAD, parametric modeling, or 3D printing work that involves sketches, constraints, extrudes, cuts, revolves, sweeps, lofts, fillets, chamfers, shells, holes, bosses, ribs, patterns, repeats, mirrors, faces, edges, shape filters, measuring, STEP or STL export. Trigger this even if the user does not explicitly say \"FluidCAD\": any time the FluidCAD MCP tools (`mcp__FluidCAD__*`) are available and the task involves 3D part design, follow this skill."
---

Provenance: maintained in the FluidCAD repo (`https://github.com/Fluid-CAD/FluidCAD`), under `mcp/skills/`. The installed local skill files are the runtime source of truth.

# FluidCAD modeling workflow

You are driving a live FluidCAD workspace through the FluidCAD MCP. The MCP is the source of truth: for the API, for what is in the scene, and for whether the latest edit compiled and built. Lean on it instead of guessing.

## Before touching the scene

1. **Find the workspace.** Call `list_workspaces` first so you know which workspace and which file you are editing.
2. **Read the docs for what you intend to use.** Even if you "know" how `sketch`, `extrude`, `cut`, `revolve`, `repeat`, `fillet` or a filter works, call `search_docs` / `read_doc` / `get_api_signature` before using it. The API evolves; assumptions from past sessions are the usual source of compile errors and wasted iterations.
3. **Resolve unfamiliar types.** When a signature mentions a type you do not fully understand (`PlaneLike`, `AxisLike`, `SceneObject`, `LinearRepeatOptions`), call `get_type_definition` on it. Do not guess at accepted forms.
4. **Read the concept doc before a new concept.** Sketch constraints, filter chaining, repeats, parameters, units: a few seconds of `read_doc` is cheaper than a failed render.

### Send sub-agents into the docs, in parallel

If your client can run sub-agents, turn that reading into one agent per API area and launch them concurrently, so the API knowledge is waiting when you start writing code.

- **Two waves, so the reading overlaps the thinking.** The baseline (sketching and the 2D primitives, `extrude` and `cut`, plane and face references) is needed by almost every part: launch it as soon as you know roughly what the part is. Once the plan names its operations, launch one agent per operation mapped to its FluidCAD counterpart: revolved feature to `revolve`, patterned holes to `repeat`, edge break to `fillet` / `chamfer`, hollowing to `shell`, swept or lofted geometry to `sweep` / `loft`, plus the face and edge filters the plan's selections will need.
- **Launch each wave in a single message** so its agents actually run concurrently.
- **One agent per API area, not per doc page.** Each returns a compact digest: the exact signature verbatim from `get_api_signature`, every type in it resolved via `get_type_definition`, one minimal snippet with its imports, and the documented gotchas and limitations, including anything the docs say is not supported.
- **Sub-agents read, they never build.** No `write_file`, `edit_range`, `recompute` or `rollback_to`. The MCP drives one live scene; concurrent writes race, and a rollback fired by a sub-agent truncates the scene you are looking at. Only the main agent touches the model.
- **Treat what comes back as a lead, not as truth.** Verify anything surprising, or anything several features will depend on, with a direct `get_api_signature` call.
- **"Can the API do what the step assumed" is itself a docs question.** If an agent reports it cannot, that is a plan change: revise the step and tell the user. Do not quietly bend the step to fit the API.

Do not block on them; carry on planning while they run. If your client cannot run sub-agents, read the docs yourself before writing code. Parallelism is an optimization, never a licence to skip the lookup.

## Default assumptions

Take these unless the user, the drawing, or the project says otherwise. Every one you rely on becomes a one-line `// ASSUMPTION:` comment next to the feature it drives.

- **Units.** Numbers in a file are in that file's unit. Resolution order: `unit('…')` in the file, then `"unit"` in the nearest `fluidcad.json`, then `mm`. Check `get_scene_summary` (`unit`) before trusting a number. Feature defaults (fillet radius 1, chamfer 1, text size 10) are plain numbers in that unit and do not scale: pass explicit sizes in a non-mm file. For one imperial dimension in a metric part use `inch()` from `fluidcad/units`; for an inch drawing put `unit('in')` right after the imports. Never multiply by 25.4 by hand.
- **Base plane and up.** Sketch the primary outline on `"xy"`; `+Z` is up; `"front"` is the XZ plane. Keep the part's natural front facing FluidCAD's front.
- **Origin.** Reference faces at the origin: a plate's bottom face on `z = 0`, a revolved part's axis on Z, a symmetric part's symmetry plane through the origin. A part that will be inserted into an assembly puts its mating face or axis at the origin.
- **Wall thickness** for an unspecified enclosure or shell: 2 to 3 mm.
- **Cosmetic fillets and edge breaks** where the user asked for "rounded" or "soft" edges without a number: 1 to 3 mm, applied last.
- **Metric clearance holes** for an unspecified bolt fit: M3 3.4, M4 4.5, M5 5.5, M6 6.6 (diameters). Model threads as plain holes at nominal diameter unless asked for thread geometry.
- **Tolerances.** Model nominal. A fit or tolerance is a comment, not a solid.

## Clarification policy

Ask **one focused question, once, batched with any others**, only when the gap makes the model:

- **impossible** to build as described (contradictory dimensions, a feature that needs surface modeling or 3D curves),
- **fit-critical** (a bore, a shaft, a mating distance, a hole pattern that must match another part with no number given),
- **safety-critical** (load-bearing wall thickness, a guard, a pressure boundary), or
- **compliance-bound** (a standard the user named without the values it fixes).

Do not ask about: a default clearance hole, a cosmetic radius, a chamfer size, an origin choice, which plane to sketch on, a wall thickness for a non-structural enclosure, whether to model threads, feature order, or naming. Take the default, mark it `// ASSUMPTION:`, and keep building.

**Autonomous fallback.** When no user is available to answer (an unattended run, a benchmark, or the user said to proceed without them), the defaults are the whole procedure: proceed on assumptions, keep the build moving, and list every assumption in the final report. Do not stall.

## Check the spec against itself before planning

A spec written by hand can contradict its own geometry, and the contradiction is invisible in the numbers until two features share the same space. Before planning, do the arithmetic for every feature that lives inside or next to another one, in one line each:

- **A hole, slot or pocket against the wall it sits in.** Its outline (centre plus radius, or slot ends plus half-width) must lie inside the material with wall left on every side, and must not break into a bore, another hole or an outside face it was not meant to reach. A bolt at `x = 22` with a 5 mm drill spans 19.5 to 24.5; a 47 mm bore around the same axis reaches 23.5: that hole breaks into the bore, and no build order fixes it.
- **A hole or slot against the body above it.** Whatever a fastener enters from must be open: nothing may stand over the outline on the insertion side. A pedestal 60 wide over slots that run from 28 to 42 buries 2 mm of each slot, and the bolt head no longer seats.
- **A fastener chain.** Head seat, then each thickness it passes, then engagement, then the hole floor: the numbers must add up with clearance at the tip. A 30 mm screw seated 14 mm above a split face with a 14 mm tapped hole below it bottoms out by 2 mm.
- **A part inside another part's envelope.** Rings, balls, pins and shafts against the width and bore they sit in; a fastener axis against every body it crosses on its way (a bolt at `y = 0` through a bearing plane centred on `y = 0` passes through the bearing).

A number that fails this check is a **spec conflict**, and the clarification policy applies: it makes the model impossible as described, so ask when a user is present. Unattended, choose the fix that keeps the function (move the bolt pattern outboard of the bore, narrow the pedestal clear of the slots, shorten the screw or deepen the hole), write it as a `// DEVIATION:` comment on the feature, and put it at the top of the report. Never build the conflict as written and hand it in, and never wrap it in an `// ASSUMPTION:`: an assumption that produces two bodies in the same space is not an assumption, it is the defect.

## Plan the part before writing code

The plan is the cheapest artifact in the project to change: a few paragraphs, against a model with six dependent features. Restate the requirements, pin down the dimensions that matter, then write the plan the way an experienced CAD designer would.

Write it in **generic CAD terms**, the vocabulary every parametric modeler shares. No FluidCAD API names, no `.fluid.js` syntax, no other package's menu names. "Sketch the outline on the front datum plane and extrude it through the full thickness", never `extrude(40)`. The user can review the approach in whatever CAD tool they know; it forces feature-and-intent thinking instead of API-call thinking; and it is the artifact that drives the doc lookups and the build order.

### What the plan contains

**a. Design intent.** What the part is, what it mounts to or does, and which dimensions are functional (bores, mating faces, hole patterns, wall thickness) versus incidental.

**b. Setup: datums, origin, symmetry.** Which faces and axes are the references, where the origin sits, what symmetry the part has and how the build exploits it.

**c. Ordered feature steps.** Numbered; for each step: **what** the feature is, generically; **on what** it is built (which datum plane or which face of which earlier feature); **which dimensions** drive it; **why** it sits at that point in the order. If you cannot say why a step comes where it does, the order is arbitrary, and an arbitrary order is the one that bites.

The default sequence: base stock (the envelope, usually the primary outline through the full thickness), then additive (bosses, pads, ribs), then subtractive (holes, pockets, slots, counterbores), then dress last (fillets, chamfers, shells, drafts).

**d. Pitfalls, called against this part.** Not a checklist recited back, but the traps this geometry sets: "the 3 mm corner radius must come after the corner bolt holes or it swallows them"; "the shell waits until the boss exists, or the boss comes out hollow".

### How a professional thinks

- **Model the way the part is made** where sensible: start from stock and remove material.
- **Capture design intent, not just geometry.** The hole centered on the boss, the wall driven by one dimension. Geometry that merely looks right breaks the first time a dimension changes.
- **Keep sketches simple and fully constrained.** Complexity belongs in the feature tree, not in one giant sketch.
- **Reference things that move.** Sketch on datum planes and on faces of earlier features, never on an offset that duplicates a dimension stated elsewhere.
- **One feature, one idea.** Dress features are separate features and come last; they are the most likely to change and to fail.
- **Patterns over copies, mirrors over duplicate modeling.** A pattern carries count and spacing as parameters.
- **Model nominal geometry.**
- **Avoid:** rounding or shelling too early; building on a face a later feature destroys; starting with detail before the envelope exists; hard-coding derived numbers; making the first sketch do too much.

### Fix the origin and orientation before the first line of code

- **Reference faces at the origin.** Each dimension then appears in the code verbatim, with no arithmetic offsets to get wrong.
- **Let symmetry pay for itself.** A symmetry plane through the origin makes mirrored features free and left/right dimensions plus or minus half.
- **Keep the part's natural front facing FluidCAD's front.** Named screenshot views then read directly against the requirements. Rotating the part into a "nicer" orientation means re-mapping views for the rest of the session, and that is where side-of-the-part mistakes come from.
- **State the choice in one line before modeling.** "Origin at the center of the main bore on the bottom face, part symmetric about the YZ plane." Correcting this now is free.

### Then use the plan

Show it. When a user is present, pause for them, and confirm before the first feature and before any step where you made a non-obvious choice. Under the autonomous fallback, the plan goes into the report and the build starts. Either way the plan is the script: it decides which docs to fetch and supplies the build order. If something you learn later forces a change, say so and revise it; do not silently diverge.

## Writing the code

- **Import every symbol** from `fluidcad/core`, `fluidcad/filters`, `fluidcad/constraints`, `fluidcad/units`. `write_file` and `edit_range` refuse files with missing imports (code `missing-imports`); the error's `details.suggestion` is a paste-ready import block.
- **Every real dimension is a named `const`** at the top of the file, named after the feature it drives. The file then reads as a specification anyone can diff against the requirements.
- **Derive dependent dimensions instead of retyping them:** `const boltCircleR = plateDia / 2 - edgeMargin;`.
- **Prefer built-ins over hand math.** A circular `repeat` on the `cut()`, not hand-computed hole angles.
- **Prefer feature repeat over sketch pattern.** Repeating the feature keeps each instance a first-class entity you can filter, fillet or reference later.
- **Sketch on face references, not transformed planes.** `sketch(e.endFaces(), ...)` moves with the extrude; `sketch(plane("xy", 40), ...)` is a magic-number duplicate of geometry that already exists.
- **Keep features small and named clearly.** One feature per logical operation makes filters such as `face().cylinder(5)` and `edge().circle(5)` predictable. `face().cylinder()` is a full bore; a fillet or rounded corner is `face().cylinderCurve()`.
- **Comment the decisions.** Anything the user resolved, every `// ASSUMPTION:`, and anything you deliberately did not model (thread forms, surface finish, knurls). Silence reads as an oversight; a comment reads as a decision.
- **Colour every body that meets another body.** Colours are model content (they survive features and export to STEP), not a viewing aid, so they are written once and kept. Give a distinct colour to every body that touches, fits into or moves against another body: each part destined for an assembly (a bare `color("steelblue")` as the last statement of the `part()` body paints the whole part), and each separate body inside a multi-body part (`color("silver", ring)`, `color("dimgray", balls)`). Pick from a palette that stays apart in a capped section: `steelblue`, `tomato`, `goldenrod`, `seagreen`, `slateblue`, `sienna`, `silver`, `dimgray`. Two mating parts never share a colour; small parts (fasteners, balls, pins) get the warm colours so they stand out inside the big grey ones. A single-body part with no neighbours needs no colour. The existing rule stands for inspection: never add a temporary `color()` to look at a selection; that is what `highlight` is for.

## Build in small increments

The first goal is not a finished part. It is the smallest solid that proves the setup is right: normally the base outline extruded to the overall thickness, nothing else. Write it, confirm `render.state === "rendered"`, screenshot, show the user. If the outline or the orientation is wrong it costs one line to fix here; six features later it costs the session.

From there, work down the plan's steps in order, one plan step (one feature, or one group of identical repeated features) per write. Say what is coming next ("base plate is done; next is the 4x 5 mm bolt pattern"). Never batch the whole part into one write: compile and build errors get harder to localize as the file grows, and a long silent stretch gives the user no chance to catch a mistake.

## After writing the code

`write_file` and `edit_range` return once the render settles. Check the outcome in this order:

1. **Render state.** If `render.state` is not `rendered`, the scene is not showing your change. On `compile-error` the previous scene is still being served: read the error (also available through `get_compile_error`), fix the source, retry. Do not screenshot or inspect a broken compile; you would be looking at the old scene.
2. **Failed features.** On `build-error` the file ran but a feature's build failed and its geometry is missing. `render.objectErrors` names each one with its message and a 1-based `sourceLocation`. A fillet whose selection resolved to nothing, a shell whose offset failed and a cut that missed all land here while everything else renders. Fix them or tell the user exactly what failed. Never report the model as done on a build error. `recompute` and `rollback_to` report the same fields; `get_scene_summary` flags the objects with `hasError`.
3. **Validate the geometry.** A clean render is not a geometry claim: an open body and an inside-out solid both render. Before measuring or screenshotting a new solid, run `validate`; `ok: true` means every rendered solid has valid topology, a closed shell and a positive volume. A finding names the shape and the object that produced it: fix that feature first, because measurements and pictures of an unsound body are not evidence of anything.
4. **Look.** Once the render is clean, `screenshot` (or `screenshot_multi` for several labelled views, or `screenshot_shape` for one shape) and confirm the geometry matches intent. "It compiled" is not "it looks right".
5. **Measure the numbers that matter.** `measure` takes filter entities as well as index entities and returns a compact summary per entity (surface or curve kind, center, normal or axis, diameter, area or length), so most measurements need no image. Two parallel faces give an overall or a wall thickness; a cylindrical face gives a bore diameter; an edge gives a fillet radius or a length. Ask for `measure`'s `image` only when the referent is in doubt or when closing out a drawing inventory. Spot-check every dimension a later feature depends on.
6. **Volume as a regression check only.** `get_shape_properties` (volume, centroid) tells you whether an edit had the effect you expected against the previous state. It cannot tell you the part is correct.

### Screenshot before you build on a feature, when the feature earns it

A screenshot serves two purposes with different cadences: a **verification gate for you** (proof a feature did what you think before the next one depends on it: required for complex features, skippable for simple ones) and a **progress checkpoint for the user** (shown at natural milestones regardless; never go a long stretch without one).

**Gate on a screenshot when the feature is complex**, meaning its result is not fully predictable from the code:

- anything driven by a **selection filter**: fillet, chamfer, shell, face and edge picks. Filters over-match and under-match; you need to see which entities were caught.
- **kernel-heavy features**: revolve, sweep, loft, helix, wrap, draft, rib, text.
- **booleans between non-trivial bodies**, and anything that can quietly do less than asked: a shell that fails to offset, a cut that misses material, an offset that collapses.
- **the first sketch on a new face or plane**: orientation and in-plane axis errors appear here and every later feature inherits them.
- **repeats and patterns**: count, spacing, and especially direction sign.
- **any feature whose faces or edges the next feature will reference.**

**Skip the gate when the feature is simple** and sits on geometry you have already seen: an extrude or cut of a rect, circle, slot or polygon on a verified plane; a plain through-hole at a known position; a translate or mirror of a body you already looked at. Batch two or three of these and verify them at the next checkpoint; never batch across a plane change or in front of a complex feature.

When in doubt, screenshot. It is one tool call; unwinding three features built on a bad one is not. When the feature is inside the part (a blind hole, a counterbore, a tapped hole, a shelled wall, a bore another part will sit in), an outside view shows nothing: pass `section` through the feature's axis and look square on. Sections through every internal fit are mandatory before "done", and they only read when the bodies are coloured; `references/verification.md` lists them and says how to read one.

### Two or more bodies: run `interfere` before you look

The moment the scene holds a second solid (a `.new()` body, a copy, a second `part()`, an inserted instance), a screenshot can no longer tell you the bodies are apart: an overlap renders as one surface hiding another. `interfere` reports every pair's shared volume; run it after the feature that added the body and again on the final state. Any `clashes` entry, and any `intraPart` entry you did not intend, is a defect to fix at its source (the spec conflict, the connector offset, the hole depth), not a line for the report. Then take the section through that pair to see where the overlap is.

## Naming geometry: resolve first, then write the synthesized selector

The selector you write is the one the tool verified. Never edit the user's file to look at geometry (no temporary `select()` or `color()` calls): a forgotten one ships, and a viewing question is not a source edit.

1. **Resolve what you mean** with `resolve_selection`, at the scope the statement will run in and at its boundary (`before`, below). Give it either an `expression` (your first guess at a filter) or `picks` (face/edge refs from `hit_test`, a highlight you looked at, or an earlier match). It returns one entry per match with its geometric summary, and `count`. Zero matches is a normal result and the one that matters most: it is exactly the selection a fillet, chamfer or shell would fail on ("the selection resolved to no edges"), and a cut aimed at nothing would silently miss. More matches than you meant is the other failure; narrow the filter (or drop picks) until the count is the count you intend.
2. **Look when the referent is in doubt.** Take a `screenshot` with `highlight` set to the same entities (highlights show through occluders, so bores and far-side faces read), `fitTo: "highlight"` to frame them, `hide` or `focus` to clear the clutter.
3. **Write `synthesized.source` into the file.** That is the selector the language itself would write for exactly those matches — the same ranked, verified synthesis the UI runs on a pick. A feature accessor on a variable (`e.endEdges()`, `c.sideFaces(2)`) beats a filter that bakes a geometry constant (`edge().circle(5)`): it survives a dimension change, the constant does not. The source form already uses the file's variable names; check `synthesized.producers[i].bound` — `false` means the producing statement has no variable yet, so put `const <variable> = ` in front of it. Add whatever `synthesized.imports` lists (`select`, `edge`, `face`, `plane`). `sameAsInput: true` means your expression already was the best form.
4. **Fall back to a filter only when synthesis refuses.** `synthesized.ok: false` names why (geometry from a loop or helper call site, picks across part scopes, a repeat instance no accessor addresses). The matches are still valid: write a filter, resolve it again, and read the count.

`synthesized.expression` is the same selector in the tool's `$obj["<id>"]` form; resolving it again is the cheapest double-check. `alternatives` are verified runner-ups when the winner reads badly in context.

**Boundary rule.** A selection is evaluated where its statement runs, not at the tip of the model. Pass `before` = the scene-object `index` (from `get_scene_summary`) of the statement the selection is written before — the statement you are editing, or the one a new statement is inserted in front of. Only objects strictly before it exist then, the same world `rollback_to(before - 1)` renders, so the fillet's edges are resolved on the solid the fillet actually sees, and picks are addressed on that world's solids. Omit `before` for a statement appended at the end of the file.

**Scoping rule.** The evaluator sees exactly what a `select(...)` at that scope sees:

- scope = a scene object or a part (id from `get_scene_summary`, or a part name): only that part's geometry, so a filter inside `part("base", ...)` never matches a face of `part("pillar", ...)`;
- no scope: the whole scene, which is what a root-level `select()` sees; every result names the part that owns it;
- assembly files: scope by `instanceId`; results carry the instance and its statement pose so they feed `measure` unchanged (no `before`, and no synthesis: selectors are written in the part file);
- `.from(obj)` inside the expression crosses parts, as it does in source.

Indices from `hit_test` and the scene summary still work as a fallback, but they renumber after every feature; a filter survives edits, and an accessor survives more.

## When something is wrong, roll the scene back and look

When a feature comes out wrong, or a later feature fails because an earlier one was already wrong, do not re-read the source harder. Step the scene back to the state that produced the problem and look.

**Find the index.** `get_scene_summary` returns every scene object with its index, kind, parameters, 1-based source location and the shape ids it produced: the map from "the feature I care about" to both the index to roll back to and the line that produced it.

**Roll back and screenshot.** `rollback_to(index)` renders the model up to that step only. It changes render state only: the source file is untouched, the module is not re-run, shape ids stay valid. `list_shapes` at a rolled-back state returns only what exists up to that index, a quick check on what a feature actually produced.

Three uses that pay off repeatedly:

- **Inspect the inputs to a failing feature.** `resolve_selection` its filter with `before` = the feature's index (the rollback is only for looking: pass `before` and the resolver sees the same world), then roll back and screenshot with `highlight`. A fillet that errors, a cut that misses or a shell that fails almost always means the face or edge it was handed was already wrong.
- **Bisect a part that is wrong at the end.** Roll back to the middle index, look, halve again. Two or three screenshots localize the culprit faster than re-reading the file.
- **Compare against a reference at an intermediate stage.** Requirements and reference views often correspond to a mid-build state, before fillets, chamfers and shells cover the underlying geometry. `measure` the base dimensions there.

**Restore before continuing.** A rollback clears on the next full render, but do not rely on it: call `recompute` and confirm the full scene is back before writing more, so the user is not left staring at a truncated part.

### Breakpoints are a different mechanism; reach for them only when rollback cannot help

| | `rollback_to` | `add_breakpoint` |
|---|---|---|
| What it does | Re-renders an already-built scene truncated at a feature index | Inserts a real `breakpoint()` statement into the source and aborts execution there on the next render |
| Touches the source file | No | Yes, with the weight of any other write |
| Re-runs the module | No: fast, shape ids stay valid | Yes, and execution stops: nothing after that line is built |
| Synchronous | Yes | No: returns `success` as soon as the request is sent |
| Needs an editor attached | No | Yes: routed through the VSCode/Neovim extension. On a standalone `fluidcad serve` it returns success and does nothing |
| Clears itself | Yes, on the next full render | No: the statement stays until `clear_breakpoints` removes it |

**Default to rollback.** Reach for a breakpoint only when the state you need never becomes a scene object: the module throws partway through, or the geometry lives inside a loop, a helper or a sketch body and fails before anything reaches the scene.

When you do use one: say so before doing it and strip it with `clear_breakpoints` the moment you are done. Do not trust the line convention: `add_breakpoint` documents `line` as zero-based while every `sourceLocation` the server returns is 1-based, so pass the line, then `read_file` and confirm where the `breakpoint()` statement actually landed before drawing conclusions from the partial scene. Because the call is fire-and-forget, verify the result rather than assuming it took effect.

## Handling unsaved-buffer conflicts

`write_file` and `edit_range` refuse to clobber a buffer the editor has unsaved changes for (code `dirty-buffer`). Surface the conflicting paths to the user and ask before retrying with `force: true`. Overwriting their in-progress work without checking is a serious failure.

## Known limitations

FluidCAD does not currently support **3D curves** (work around by sketching on several planes and combining), or **surface modeling and sheet metal**. If the request fundamentally needs them, say so up front rather than faking it with solids.

## Progressive references

Load only what the task needs, from this skill's `references/` folder:

- `references/traps.md`: read before fillet, chamfer, shell, cut, repeat, `plane()` offsets, sketching on a face, or a breakpoint. FluidCAD-specific silent failures with their signatures and fixes.
- `references/repair-loop.md`: read the moment `render.state` is not `rendered`. Failure classes keyed by the actual `compileError` and `objectErrors` messages, with the smallest fix and what to rerun.
- `references/verification.md`: read before declaring any feature or part done. Screenshot skip list, the visual-concern-to-deterministic-check table, the mandatory `interfere` and section gates and how to read a section, what never to claim, the final report template.
- `references/modifying.md`: read when the task starts from an existing file rather than a blank one.
- `references/sketching.md`: read before the first constrained sketch, or when a sketch solves somewhere you did not draw it.
- `references/handoff.md`: read when the user wants an STL, a STEP, a package, or asks "how do I use this".

Assemblies (parts, inserts, mates, connectors) are covered by the separate **FluidCAD-assembly** skill; modeling from a drawing by **FluidCAD-from-drawing**.

## Quick reference: the loop

1. Read the docs for the step (`search_docs` / `read_doc` / `get_api_signature` / `get_type_definition`), in parallel sub-agents where possible. Sub-agents read; they never build.
2. Agree on the step with the user when one is present; otherwise proceed on stated assumptions. Spec conflicts (a hole that breaks into a bore, a slot under a wall, a fastener that bottoms out) are found and settled before the first write.
3. Write the code with all imports, dimensions as named consts, dependents derived, and a colour on every body that meets another body.
4. Check `render.state`; fix compile errors and every `objectErrors` entry before going further.
5. `validate` every new solid; `interfere` as soon as there are two; then screenshot when the feature earns it (a `section` through anything internal), and `measure` the numbers a later feature depends on.
6. Before a filter-driven feature, `resolve_selection` your expression or picks at the right scope and boundary, `highlight` it if in doubt, then write `synthesized.source`.
7. When something looks wrong, `rollback_to` the feature before it and look; `recompute` to restore before writing more.
8. Move on to the next feature.

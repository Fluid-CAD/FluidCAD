---
name: FluidCAD
description: Workflow and best practices for designing parts in FluidCAD through its MCP server. Use this skill whenever the user wants to model, design, or modify any part in FluidCAD, whenever they mention FluidCAD, a `.fluid.js` file, or ask for CAD/parametric modeling work that involves sketches, extrudes, cuts, fillets, patterns, repeats, faces, edges, or shape filters. Trigger this even if the user does not explicitly say "FluidCAD" — any time the FluidCAD MCP tools (`mcp__fluidcad__*`) are available and the task involves 3D part design, follow this skill.
---

# FluidCAD modeling workflow

You are driving a live FluidCAD workspace through the FluidCAD MCP. The MCP is the source of truth — for the API, for what is currently in the scene, and for whether the latest edit compiled. Lean on it instead of guessing.

## Before touching the scene

1. **Find the workspace.** Call `list_workspaces` first so you know which workspace and which `.fluid.js` file you are editing.
2. **Read the docs for what you intend to use.** Even if you "know" how `sketch`, `extrude`, `cut`, `revolve`, `repeat`, `fillet`, or a filter works, call `search_docs` / `read_doc` / `get_api_signature` before using it. The API evolves, and assumptions from past sessions are a common source of compile errors and wasted iterations.
3. **Resolve unfamiliar types.** When a signature mentions a type you do not fully understand (`PlaneLike`, `AxisLike`, `SceneObject`, `LinearRepeatOptions`, etc.), call `get_type_definition` on it. Do not guess at accepted forms.
4. **Understand base concepts before modeling.** If the task touches a concept you have not used yet (sketch constraints, filter chaining, repeats, parameters), read the relevant doc before writing code. A few seconds of reading is cheaper than a failed recompute.

### Send sub-agents into the docs, in parallel

If your client can run sub-agents, turn that reading into one agent per API area and launch them concurrently. The API knowledge is then waiting when you start writing code, instead of arriving one blocking lookup at a time.

- **Two waves, so the reading overlaps the thinking.** The baseline — sketching and the 2D primitives, `extrude` and `cut`, how plane and face references work — is needed by almost every part, so launch it as soon as you know roughly what the part is, before the plan exists. Then, once the plan names its operations, launch one agent per operation mapped to its FluidCAD counterpart: revolved feature → `revolve`, patterned holes → `repeat`, edge break → `fillet` / `chamfer`, hollowing → `shell`, swept or lofted geometry → `sweep` / `loft`, plus the face and edge filters the plan's selections will need.
- **Launch each wave in a single message** so its agents actually run concurrently.
- **One agent per API area, not per doc page.** Each returns a compact, directly usable digest:
  - the **exact signature, verbatim** from `get_api_signature` — not a prose recollection of it
  - every type in that signature resolved via `get_type_definition`, with its accepted forms
  - one minimal snippet showing the call in context, including the imports it needs
  - documented gotchas, sign conventions, and limitations — explicitly including anything the docs say is *not* supported

  Keep the digests short. You need a call form you can act on, not a doc dump.
- **Sub-agents read, they never build.** No `write_file`, no `edit_range`, no `recompute`, no `rollback_to`. The MCP drives one live workspace with one scene — concurrent writes race, and a rollback fired by a sub-agent silently truncates the scene the main agent is looking at. Only the main agent touches the model.
- **Treat what comes back as a lead, not as truth.** Sub-agents can misreport. That is why the contract asks for a verbatim signature — anything surprising, or anything you are about to build several features on, verify yourself with a direct `get_api_signature` call before depending on it.
- **Whether the API can do what you assumed is itself a question for the docs.** A plan step says "revolved boss"; whether FluidCAD's `revolve` accepts the axis form that step assumed is something to confirm. If an agent reports the API cannot do what a step assumed, that is a **plan change** — revise the step and tell the user. Do not quietly bend the step to fit whatever the API happens to offer.

Do not block on them: only the code-writing step actually needs the digests, so carry on planning while they run. And if your client cannot run sub-agents, nothing changes about the requirement — read the docs yourself before writing code. Parallelism is an optimization, never a licence to skip the lookup.

## Plan the part before writing code

Before writing any code, agree with the user on the plan. It is the cheapest artifact in the project to change: a few paragraphs, against a model with six dependent features.

1. **Restate the requirements.** Confirm what the part is for and what features it must have.
2. **Pin down dimensions and tolerances.** Surface anything ambiguous now, not after modeling.
3. **Write the plan the way an experienced CAD designer would**, and put it in front of the user.

Write it in **generic CAD terms** — the vocabulary every parametric modeler shares. No FluidCAD API names, no `.fluid.js` syntax, and no other package's menu names either. "Sketch the outline on the front datum plane and extrude it through the full thickness," never `extrude(40)`.

Generic wording is not a stylistic preference, it earns three things:

- **The user can review the approach**, whatever CAD tool they know, and correct it before a single line of code exists.
- **It forces feature-and-intent thinking** instead of API-call thinking. Modeling mistakes come from a bad plan far more often than from a misremembered signature.
- **It is the artifact that drives everything after it.** The same plan selects which docs to read and supplies the build order.

### What the plan contains

**a. Design intent.** A short paragraph: what the part is, what it mounts to or does, and which dimensions are functional — bores, mating faces, hole patterns, wall thickness — versus incidental. Everything downstream follows from this. A model built without stated intent comes out dimensionally correct and impossible to revise.

**b. Setup — datums, origin, symmetry.** Which faces and axes are the references, where the origin sits, what symmetry the part has and how the build will exploit it.

**c. Ordered feature steps.** Numbered, and for each step state four things:

- **what** the feature is, generically — base extrude, revolved boss, counterbored hole, circular pattern, edge fillet
- **on what** it is built — which datum plane, or which face of which earlier feature
- **which dimensions** drive it
- **why it sits at that point in the order**

That last one is what separates a professional's plan from a list of operations. If you cannot say why a step comes where it does, the order is arbitrary, and an arbitrary order is the one that bites.

The default shape of the sequence:

1. **Base / stock** — the overall envelope, usually the part's primary outline extruded through the full thickness.
2. **Additive** — bosses, pads, ribs.
3. **Subtractive** — holes, pockets, slots, counterbores.
4. **Dress last** — fillets, chamfers, shells, drafts.

**d. Pitfalls, called against *this* part.** Not a checklist recited back, but the specific traps this geometry sets: "the 3 mm corner radius must come after the corner bolt holes or it will swallow them"; "the shell has to wait until the boss exists, or the boss comes out hollow"; "the rib is drafted before it is filleted, not after."

### How a professional thinks — the guidance behind the steps

- **Model the way the part is made**, where that is sensible: start from stock and remove material. The resulting feature tree matches how the part is inspected and how it will be revised.
- **Capture design intent, not just geometry.** Relate features to each other — the hole centered on the boss, the wall thickness driven by one dimension — rather than typing independent coordinates that happen to line up. Geometry that merely *looks* right breaks the first time a dimension changes.
- **Keep sketches simple and fully constrained.** Complexity belongs in the feature tree, not in one giant sketch.
- **Reference things that move.** Sketch on datum planes and on faces of earlier features — never on an arbitrary offset that silently duplicates a dimension stated elsewhere.
- **One feature, one idea.** Multi-purpose features are unmaintainable and fail unpredictably.
- **Dress features are separate features, and they come last.** They are the most likely to change and the most likely to fail; keeping them at the end of the tree makes both cheap.
- **Patterns over copies, mirrors over duplicate modeling.** A pattern carries count and spacing as parameters; four hand-placed copies carry nothing.
- **Model nominal geometry.** Tolerances are a note, not a solid.

### Generic pitfalls to avoid

- **Rounding too early.** Fillets and chamfers placed before the features that intersect them absorb those features or fail on regeneration.
- **Shelling too early**, or shelling around tight internal geometry — the offset fails, often silently.
- **Building on geometry a later feature destroys.** Reference a face that gets consumed and the tree breaks on the next change.
- **Starting with detail features** before the overall envelope exists.
- **Hard-coding derived numbers.** A value that is the sum or difference of two others should be computed from them.
- **Making the first sketch do too much.** Outline plus holes plus slots in one sketch collapses them into geometry that nothing downstream can select.

### Fix the origin and orientation before the first line of code

This is where the plan's datum decision becomes a coordinate system.

- **Put the part's reference faces at the origin.** Those faces are what every dimension is measured from; placing them at zero makes each dimension appear in the code verbatim, with no arithmetic offsets to get wrong.
- **Let symmetry pay for itself.** If the part is symmetric about a plane, put that plane through the origin — mirrored features become free, and left/right dimensions become ±half instead of two independent numbers.
- **Keep the part's natural front facing FluidCAD's front.** `screenshot_multi` returns front / top / right / iso-ftr as a 2×2 grid; if the part is oriented conventionally, that grid can be read directly against the requirements. Rotating the part into a "nicer" orientation means mentally re-mapping views for the rest of the session, and that is where side-of-the-part mistakes come from.
- **State the choice in one line before modeling** — "origin at the center of the main bore on the bottom face, part symmetric about the YZ plane." Correcting this now is free; correcting it after four features is not.

### Then use the plan

Show it and pause for the user, and **confirm before each major step** afterwards — especially on the first feature and on any step where you made a non-obvious choice. It is far cheaper to course-correct on a sketch than after three dependent features.

From there the plan is the script: it decides which docs to fetch and supplies the build order. If something you learn later forces a change to the plan, say so and revise it — do not silently diverge from the plan the user agreed to.

## Writing the code

- `.fluid.js` files must import every FluidCAD symbol they use. `write_file` and `edit_range` reject files missing imports with code `missing-imports`; the error's `details.suggestion` is a paste-ready import block — use it.
- **Every real dimension becomes a named `const` at the top of the file**, named after the feature it drives. The file then reads as a specification anyone can diff against the requirements.
- **Derive dependent dimensions instead of retyping them** — `const boltCircleR = plateDia / 2 - edgeMargin;`. A retyped number is a number that will drift.
- **Prefer built-ins over hand math.** If FluidCAD has a function for what you need, use it. For a circular pattern of holes, use a circular `repeat` on the `cut()` feature, not hand-computed angles. The math version is harder to read, harder to parameterize, and easier to get subtly wrong.
- **Prefer feature repeat over sketch pattern.** Repeating the feature (e.g., repeating a `cut()`) keeps each instance as a first-class entity you can filter, fillet, or reference later. Patterning inside the sketch collapses them into one indistinguishable blob. Only pattern in the sketch when you have a specific reason.
- **Sketch on face references, not transformed planes.** When the sketch sits on an existing face, pass that face directly — the sketch then moves with the feature it is attached to and survives parameter changes. A hand-positioned `plane()` is a brittle, magic-number duplicate of geometry that already exists.

  ```javascript
  // Good — sketch follows the end face of the extrude
  const e = extrude(40);
  sketch(e.endFace(), ...)

  // Bad — plane offset is a duplicated literal; changes to the extrude won't carry over
  const e = extrude(40);
  sketch(plane("top", 40), ...)
  ```

- **Keep features small and named clearly.** One feature per logical operation makes selection filters (`face().cylinder(50)`, `edge().circle(50)`) far more predictable.
- **Comment the decisions.** Anything the user resolved for you goes in a comment next to the feature it decided — the next reader will have the same question. So does anything you deliberately did **not** model (thread forms, surface finish, knurls): silence reads as an oversight, a comment reads as a decision.

## Build in small increments

The first goal is **not** a finished part. It is the smallest solid that proves the setup is right — normally just the base outline extruded to the overall thickness, and nothing else. Write it, confirm `render.state === "rendered"`, screenshot, and show the user. If the outline or the orientation is wrong, it costs one line to fix at this point. Discovered six features later, it costs the session.

From there, **work down the plan's steps in order**, growing the model in the smallest increments that produce a visible change:

- one plan step — one feature, or one group of identical repeated features — per write
- say what is coming next ("base plate is done; next is the 4× ⌀5 bolt pattern")
- never batch the whole part into one write and hope. Compile errors and geometry errors both get dramatically harder to localize as the file grows, and a long silent stretch gives the user no chance to catch a mistake.

Checkpoints are cheap. Rework is not.

## After writing the code

`write_file` and `edit_range` are synchronous — they return once the render settles. Check the outcome carefully:

1. **Check the render state.** If `render.state !== "rendered"`, the scene is not yet showing your change. On `compile-error`, the previous scene is still being served — read `get_compile_error`, fix the source, and retry. Do not call `screenshot` or inspection tools on a broken compile; you will be looking at the old scene.
2. **Check for failed features.** On `build-error` the file ran, but a feature's build threw and its geometry is missing from the scene — `render.objectErrors` names each one with a message and a 1-based `sourceLocation`. The render "succeeding" says nothing here: a fillet that could not be applied, a shell whose selection matched no faces, a cut that missed all fail this way while everything else renders. Fix them, or tell the user exactly what failed — never report the model as done. `recompute` and `rollback_to` report the same `objectErrors`, and `get_scene_summary` flags the objects with `hasError`.
3. **Verify visually.** Once the file compiles cleanly, take a `screenshot` (or `screenshot_multi` from several angles, or `screenshot_shape` for a specific shape) and confirm the geometry matches intent. "It compiled" is not the same as "it looks right."
4. **Measure the numbers that matter.** `measure` on two parallel faces gives an overall dimension or a wall thickness; `get_face_properties` on a cylindrical face gives a hole's `radius`; `get_edge_properties` gives a fillet radius or an edge length. In an assembly, give each entity its `instanceId` so it is measured where that instance sits (instances of one part share a `shapeId`). Spot-check every dimension a downstream feature depends on — "it looks plausible" is weaker than "it measures what was asked for."
5. **Use shape volume only as a regression check.** `get_shape_properties` (volume/mass/centroid) is the right tool when you want to compare against a previous state to confirm a change had — or did not have — the effect you expected. It cannot tell you the part is correct, and it is not a substitute for actually looking at the screenshot.

### Screenshot before you build on a feature — when the feature earns it

A screenshot serves two different purposes, and they have different cadences:

- **As a verification gate for you** — proof that a feature did what you think before the next feature depends on it. Required for complex features, skippable for simple ones.
- **As a progress checkpoint for the user** — shown at natural milestones regardless. Never go a long stretch without one.

**Screenshot and confirm before continuing when the feature is complex**, meaning its result is not fully predictable from the code you wrote:

- anything driven by a **selection filter** — fillet, chamfer, shell, face/edge picks. You need to see *which* entities were caught, and filters over-match and under-match silently.
- **kernel-heavy features** — revolve, sweep, loft, helix, wrap, draft, rib, text. The output shape depends on how the kernel handled the input, not just on your parameters.
- **booleans between non-trivial bodies**, and anything that can quietly no-op: a shell that fails to offset, a cut that misses material, an offset that collapses.
- **the first sketch on a new face or plane** — this is where orientation and in-plane axis direction errors appear, and every later feature on that plane inherits them.
- **repeats and patterns** — count, spacing, and especially direction sign. A pattern marching the wrong way looks perfectly correct in the source.
- **any feature whose faces or edges the *next* feature will reference.** If it is about to become an input, verify it first.

For these, also use the temporary `select` / `color` trick below to confirm the filter grabbed the right entities before depending on it.

**Skip the screenshot when the feature is simple** — you can predict the exact result and it sits on geometry you have already seen:

- an extrude or cut of a rect, circle, slot, or polygon on a plane you already verified
- a plain through-hole at a known position
- a translate or mirror of a body you already looked at

Batch a few of these and verify them together at the next checkpoint. Keep the batches small — two or three — and never batch across a plane change or in front of a complex feature: if the result is wrong you have given up the ability to localize it.

When in doubt, screenshot. It is one tool call; unwinding three features built on a bad one is not.

## Inspecting geometry you are about to operate on

When you need to confirm which faces or edges a filter is going to grab — before you fillet, cut, or extrude from them — use temporary selection or coloring and a screenshot:

```javascript
// Temporarily highlight to verify the filter picks the right entities
select(edge().circle(50))
select(face().cone())
```

```javascript
// Or color faces temporarily to make geometry easier to read
color("red", face().cylinder(50))
color("orange", extrusion.endFaces())
```

Take a screenshot, confirm the selection/coloring is what you expected, then remove the temporary `select` / `color` calls before committing to the next feature. This is much faster than guessing and recomputing.

## When something is wrong, roll the scene back and look at it

When a feature comes out wrong — or a later feature fails because an earlier one was already wrong — do not re-read the source harder. Step the scene back to the state that produced the problem and look.

**Find the index.** `get_scene_summary` returns every scene object with its index, kind, parameters, source location, and the shape ids it produced. That is the map from "the feature I care about" to both the index to roll back to and the line that produced it.

**Roll back and screenshot.** `rollback_to(index)` renders the model up to that step only. It changes render state only — the source file is untouched and the module is not re-run, so it is fast, it is safe, and shape ids stay valid across it. `list_shapes` at a rolled-back state returns only what is rendered up to that index, which is itself a quick check on what a feature actually produced.

Three uses that pay off repeatedly:

- **Inspect the inputs to a failing feature.** Roll back to the index *before* it and screenshot. A fillet that errors, a cut that misses material, or a shell that silently no-ops almost always means the face or edge it was handed was already wrong. With the scene paused there, use temporary `select` / `color` to see exactly what the filter catches at that point in the build.
- **Bisect a part that is wrong at the end.** When the finished model does not match the requirements and you do not know which step broke it, roll back to the middle index, look, then halve again. Two or three screenshots localize the culprit faster than re-reading the file top to bottom.
- **Compare against a reference at an intermediate stage.** Requirements and reference views often correspond to a mid-build state, before fillets, chamfers, and shells cover the underlying geometry. Rolling back to that state makes the comparison direct — and lets you `measure` the base dimensions before the dress features moved those faces.

**Restore before continuing.** A rollback clears itself on the next full render — `recompute`, or any `write_file` / `edit_range` — so it will not survive to poison your next feature. But do not *rely* on that: call `recompute` and confirm the full scene is back before writing more, so the user is not left staring at a truncated part and your next screenshot is not of a partial model.

### Breakpoints are a different mechanism — reach for them only when rollback cannot help

`rollback_to` and `add_breakpoint` are not two grains of the same tool. Confusing them wastes time and, worse, silently edits the user's file.

| | `rollback_to` | `add_breakpoint` |
|---|---|---|
| What it does | Re-renders an **already-built** scene truncated at a feature index | Inserts a real `breakpoint()` statement **into the `.fluid.js` source** and aborts execution there on the next render |
| Touches the source file | No | **Yes** — it is a source edit, with the same weight as any other write |
| Re-runs the module | No — so it is fast and shape ids stay valid | Yes, and execution *stops*: nothing after that line is built, including unrelated features |
| Synchronous | Yes — returns once the rollback render settles | No — it returns `success` as soon as the request is sent |
| Needs an editor attached | No | **Yes** — it is routed through the VSCode/Neovim extension. On a standalone `fluidcad serve` it returns success and does nothing at all |
| Clears itself | Yes, on the next full render | No — the statement stays in the file until `clear_breakpoints` removes it |

**Default to rollback.** It is free, reversible, and cannot damage anything.

**Reach for a breakpoint only when the state you need never becomes a scene object you can roll back to** — the module throws partway through, or the geometry you are chasing lives inside a loop, a helper, or a sketch body and fails before anything reaches the scene. That is the case rollback genuinely cannot cover, because rollback can only replay a build that already succeeded.

When you do use one:

- Treat it as a file edit. Say so before doing it, and strip it with `clear_breakpoints` the moment you are done — a forgotten `breakpoint()` sitting in the source truncates every later render and looks like a modeling bug.
- Do not trust the line convention. The MCP documents `line` as zero-based while the extension handler treats the incoming line as 1-indexed; pass the `sourceLocation` line from `get_scene_summary`, then **read the file back and confirm where the `breakpoint()` statement actually landed** before drawing conclusions from the partial scene.
- Because the call is fire-and-forget, verify the result — re-read the source and check the scene — rather than assuming the breakpoint took effect. If the workspace has no editor attached, it did not.

## Handling unsaved-buffer conflicts

`write_file` and `edit_range` refuse to clobber a buffer the editor has unsaved changes for (code `dirty-buffer`). Surface the conflicting paths to the user and ask before retrying with `force: true` — overwriting their in-progress work without checking is a serious failure mode.

## Common pitfalls

Easy-to-miss behaviors that have bitten previous sessions. Re-read before reaching for these operations.

- **`extrude` and `cut` use opposite sign conventions.** A positive distance in `extrude()` goes along the sketch normal; a positive distance in `cut()` goes *opposite* to the sketch normal (into the material the sketch sits on). Transcribing a depth straight into the wrong one silently produces a feature going the wrong way.

## Known limitations

FluidCAD currently does **not** support:

- **3D curves** — work around this by sketching on multiple planes and combining the results.
- **Surface modeling and sheet metal** — these are out of scope. If the user's request fundamentally needs them, say so up front rather than trying to fake it with solids.

## Quick reference: the loop

For every modeling step, the rhythm is:

1. Read the relevant docs (`search_docs` / `read_doc` / `get_api_signature` / `get_type_definition`) — in parallel sub-agents where possible, one per API area. Sub-agents read; they never build.
2. Agree on the step with the user, working down the plan in order.
3. Write the code with all required imports, dimensions as named consts, dependents derived.
4. Check `render.state` — fix compile errors, and any `objectErrors` a `build-error` lists, before going further.
5. Screenshot and verify visually; `measure` the numbers a later feature depends on.
6. Use temporary `select` / `color` to sanity-check filters before depending on them.
7. When something looks wrong, `rollback_to` the feature before it and inspect — do not re-read the source. `recompute` to restore before writing more.
8. Move on to the next feature.

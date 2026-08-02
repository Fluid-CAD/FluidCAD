---
name: FluidCAD-from-drawing
description: Turning a 2D engineering drawing into a parametric FluidCAD model. Use this skill whenever the user supplies a drawing, blueprint, dimension sheet, hand sketch, screenshot, PDF, or photo of a part and wants it modeled — "model this", "build this part", "make this in CAD", "here's the drawing". Trigger it alongside the FluidCAD skill any time the FluidCAD MCP tools (`mcp__fluidcad__*`) are available and the geometry is being read off a drawing rather than described in conversation.
---

# Modeling a part from a drawing

This skill layers on top of the **FluidCAD** skill — that one owns the MCP loop (read the docs, write the file, check `render.state`, screenshot). Follow it. This skill covers what is specific to working from a drawing: reading it correctly, sequencing the build, and getting something on screen fast enough that a misreading costs one line instead of six features.

The governing principle: **a drawing is a specification you are transcribing, not a picture you are approximating.** Every number in the model should trace back to a number on the sheet.

## 1. Read the entire drawing before modeling anything

Open the drawing with whatever file/image reading tool your client provides — and for a multi-page PDF, read every page, not just the first.

**Read the original image, whole.** Do not crop it, tile it into quadrants, split out a region, zoom-and-slice, or otherwise preprocess it into sub-images to pull the dimensions out. It feels like it should help; it does not:

- **Cropping strips the context that gives a number its meaning.** A dimension is defined by the extension lines it spans, the arrowheads at its ends, and the view it sits in. Isolated in a tile, `24` is just a number with no referent — and that is exactly how a width gets modeled as a depth.
- **Splitting causes both double-counting and omission.** The same dimension shows up in two tiles and gets modeled twice, or it lands on a seam and vanishes from both. Neither failure announces itself.
- **Re-encoding adds no information.** Enlarging a blurry region does not recover pixels the original never had; it produces confident-looking digits that were never on the sheet. A misread you invented this way is indistinguishable from a real reading.

If something is genuinely unreadable at full size, that is a question for the user (§2), not a problem to solve with image processing.

- **Start with the title block.** Units (mm or inch), scale, projection angle (first vs third), general tolerance note, material, revision. These change how you interpret every view. FluidCAD works in millimetres; if the drawing is in inches, decide the conversion policy with the user up front.
- **Inventory the views.** Which are orthographic (front/top/right), which are sections, which are detail blow-ups. For a section, note where the cutting plane is — a section shows internal geometry, not an outer face.
- **Dashed lines are hidden geometry.** They are bores, pockets, and counterbores seen through material — internal features to cut, never outlines to extrude.
- **Decode the callouts** before you rely on them: `⌀` diameter, `R` radius, `SR` spherical radius, `□` square, `⌴` counterbore, `⌵` countersink, `↧` depth, `THRU`, `TYP`, `4X`, `±`, bolt-circle notation, thread callouts (`M6×1`, `1/4-20 UNC`).
- **Build a dimension inventory.** List every dimension on the sheet: its value, the view it came from, and the feature it will drive. This list doubles as the completion checklist — at the end, every entry must be consumed by a modeled feature or explicitly waived with the user.
- **Check the arithmetic.** Chained dimensions should sum to the stated overall; hole positions should fall inside the outline; a bolt circle should clear the edge. A mismatch means either you misread a digit or the drawing is wrong. Both need the user, not a guess.

Before settling into the careful pass, take one **glance** at the sheet — just enough to see what kinds of features the part has — and launch the baseline doc sub-agents (§4, wave 1) so they read while you read.

## 2. Ask about anything you cannot read — batched into one round

**Never guess.** Not a digit, not a unit, not whether a line is a hidden edge or a centerline. An 8 read as a 3 propagates silently through every downstream feature and is expensive to unwind. Guessing is the single most costly failure mode in this workflow.

But do not block on each unknown one at a time either. Read the whole drawing, collect every ambiguity, then ask **one consolidated set of questions**. Typical items:

- illegible, cut-off, or ambiguous numbers — ask the user for a better scan or a higher-resolution copy of the sheet, and read that new source whole. Never try to recover the digits yourself by cropping or upscaling the drawing you already have (§1).
- dimensions that are missing entirely, or chains that do not close
- whether threads should be modeled as real geometry or left as plain holes at nominal/tap-drill size
- whether to model nominal dimensions or a specific fit
- features the drawing shows but does not dimension
- which revision governs, if more than one drawing was supplied

Anything the user answers, write into the code as a comment next to the feature it decided. The next reader will have the same question.

## 3. Write the build plan a CAD professional would write — and show it to the user

Before any FluidCAD-specific work, write out how an experienced CAD designer would build this part, and put it in front of the user.

Write it in **generic CAD terms** — the vocabulary every parametric modeler shares. No FluidCAD API names, no `.fluid.js` syntax, and no other package's menu names either. "Sketch the outline on the front datum plane and extrude it through the full thickness," never `extrude(40)`.

Generic wording is not a stylistic preference, it earns three things:

- **The user can review the approach**, whatever CAD tool they know, and correct it before a single line of code exists.
- **It forces feature-and-intent thinking** instead of API-call thinking. Modeling mistakes come from a bad plan far more often than from a misremembered signature.
- **It is the artifact that drives everything after it.** The same plan selects which docs to read (§4) and supplies the build order (§6).

### What the plan contains

**a. Design intent.** A short paragraph: what the part is, what it mounts to or does, and which dimensions are functional — bores, mating faces, hole patterns, wall thickness — versus incidental. Everything downstream follows from this. A model built without stated intent comes out dimensionally correct and impossible to revise.

**b. Setup — datums, origin, symmetry.** Which faces and axes are the references, where the origin sits, what symmetry the part has and how the build will exploit it. State it in drawing terms: "datum A is the bottom mounting face; the part is symmetric about the vertical centerline of the front view." §5 turns this into FluidCAD's coordinate system.

**c. Ordered feature steps.** Numbered, and for each step state four things:

- **what** the feature is, generically — base extrude, revolved boss, counterbored hole, circular pattern, edge fillet
- **on what** it is built — which datum plane, or which face of which earlier feature
- **which dimensions** from the inventory drive it
- **why it sits at that point in the order**

That last one is what separates a professional's plan from a list of operations. If you cannot say why a step comes where it does, the order is arbitrary, and an arbitrary order is the one that bites.

The default shape of the sequence:

1. **Base / stock** — the overall envelope, usually the outline of the most informative view extruded through the full thickness.
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
- **Model nominal geometry.** Tolerances live on the drawing, not in the solid.

### Generic pitfalls to avoid

- **Rounding too early.** Fillets and chamfers placed before the features that intersect them absorb those features or fail on regeneration.
- **Shelling too early**, or shelling around tight internal geometry — the offset fails, often silently.
- **Building on geometry a later feature destroys.** Reference a face that gets consumed and the tree breaks on the next change.
- **Modeling from the pictorial view.** The isometric shows shape; only the dimensioned orthographic views carry the numbers.
- **Starting with detail features** before the overall envelope exists.
- **Hard-coding derived numbers.** A value that is the sum or difference of two others should be computed from them.
- **Making the first sketch do too much.** Outline plus holes plus slots in one sketch collapses them into geometry that nothing downstream can select.
- **Treating a cosmetic thread callout as real helical geometry** when a plain hole is what is wanted — ask (§2).

### Then use the plan

Show it and pause for the user. It is the cheapest artifact in the project to change — a few paragraphs, against a model with six dependent features. If the user does CAD, they can correct the entire approach in one message.

From there the plan is the script: §4 reads its operations to decide which docs to fetch, and §6 builds its steps one at a time, in the order it states. If something you learn later forces a change to the plan, say so and revise it — do not silently diverge from the plan the user agreed to.

## 4. Send sub-agents into the docs — the plan tells you which

The plan names every operation the part needs. That list *is* the doc list: turn each operation into one sub-agent that reads the FluidCAD docs for it and comes back with a usable call form. Doing them in parallel means the API knowledge is waiting when you start writing code, instead of arriving one blocking lookup at a time.

**Two waves**, so the reading overlaps the thinking:

- **Wave 1 — baseline, launched right after the glance in §1.** Every part needs sketching and the 2D primitives, extrude and cut, and how plane and face references work. You do not need the plan to know that. Launch these first and let them run while you read the sheet and write the plan.
- **Wave 2 — plan-derived, launched the moment the plan is written.** One agent per operation the plan names, mapped to its FluidCAD counterpart: revolved feature → `revolve`, patterned holes → `repeat`, edge break → `fillet` / `chamfer`, hollowing → `shell`, swept or lofted geometry → `sweep` / `loft`, plus the face and edge filters the plan's selections will need.

Launch each wave in a **single message** so its agents run concurrently.

**One agent per API area, not per doc page.** Each returns a compact, directly usable digest:

- the **exact signature, verbatim** from `get_api_signature` — not a prose recollection of it
- every type in that signature resolved via `get_type_definition`, with its accepted forms
- one minimal snippet showing the call in context, including the imports it needs
- documented gotchas, sign conventions, and limitations — explicitly including anything the docs say is *not* supported

Keep the digests short. You need a call form you can act on, not a doc dump.

**The generic-to-FluidCAD mapping is itself a question for the docs, not an assumption.** The plan says "revolved boss"; whether FluidCAD's revolve accepts the axis form the step assumed is something to confirm. If an agent comes back reporting that the API cannot do what a step assumed, that is a **plan change** — return to §3, revise the step, and tell the user. Do not quietly bend the step to fit whatever the API happens to offer.

Two hard rules on the split of work:

- **The drawing never leaves the main agent.** Do not hand the image to a sub-agent to "extract the dimensions." A sub-agent returns a summary, and a summarized dimension is a number stripped of the extension lines, arrowheads, and view that gave it meaning — the same failure that makes cropping unsafe, with a lossy retelling on top. You read the sheet; they read the docs.
- **Sub-agents read, they never build.** No `write_file`, no `edit_range`, no `recompute`, no `rollback_to`. The MCP drives one live workspace with one scene — concurrent writes race, and a rollback fired by a sub-agent silently truncates the scene the main agent is looking at. Only the main agent touches the model.

Treat what comes back as a lead, not as truth: sub-agents can misreport. That is why the contract asks for a verbatim signature — anything surprising, or anything you are about to build several features on, verify yourself with a direct `get_api_signature` call before depending on it.

Do not block on them. While they run, carry on into origin and orientation — only the code-writing step actually needs the digests. And if your client cannot run sub-agents at all, nothing changes about the requirement: read the docs yourself before writing code, as the FluidCAD skill requires. Parallelism is an optimization, never a licence to skip the lookup.

## 5. Fix the origin and orientation before the first line of code

This is where the plan's datum decision (§3b) becomes a coordinate system.

- **Put the drawing's datums at the origin.** The datum faces are what every dimension is measured from; placing them at zero makes each dimension appear in the code verbatim, with no arithmetic offsets to get wrong.
- **Let symmetry pay for itself.** If the part is symmetric about a plane, put that plane through the origin — mirrored features become free, and left/right dimensions become ±half instead of two independent numbers.
- **Align the drawing's front view with FluidCAD's front view.** Then `screenshot_multi` — which returns front / top / right / iso-ftr as a 2×2 grid — can be laid next to the drawing sheet and compared 1:1. Rotating the part into a "nicer" orientation means mentally re-mapping views for the rest of the session, and that is where side-of-the-part mistakes come from.
- **State the choice in one line before modeling** — "origin at the center of the main bore on the bottom face, part symmetric about the YZ plane, front view matches the drawing's front view." Correcting this now is free; correcting it after four features is not.

## 6. Build the minimum viable solid first, then show it

The first goal is **not** a finished part. It is the smallest solid that proves you read the drawing correctly — normally just the base outline extruded to the overall thickness, and nothing else.

Write it, confirm `render.state === "rendered"`, screenshot, and show the user. If the outline or the orientation is wrong, it costs one line to fix at this point. Discovered six features later, it costs the session.

From there, **work down the plan's steps in order**, growing the model in the smallest increments that produce a visible change:

- one plan step — one feature, or one group of identical repeated features — per write
- say what is coming next ("base plate matches the front view; next is the 4× ⌀5 bolt pattern")
- never batch the whole part into one write and hope. Compile errors and geometry errors both get dramatically harder to localize as the file grows, and a long silent stretch gives the user no chance to catch a misread.

Checkpoints are cheap. Rework is not.

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

For these, also use the temporary `select` / `color` trick from the FluidCAD skill to confirm the filter grabbed the right entities before depending on it.

**Skip the screenshot when the feature is simple** — you can predict the exact result and it sits on geometry you have already seen:

- an extrude or cut of a rect, circle, slot, or polygon on a plane you already verified
- a plain through-hole at a dimensioned position
- a translate or mirror of a body you already looked at

Batch a few of these and verify them together at the next checkpoint. Keep the batches small — two or three — and never batch across a plane change or in front of a complex feature: if the result is wrong you have given up the ability to localize it.

When in doubt, screenshot. It is one tool call; unwinding three features built on a bad one is not. And when a screenshot shows something wrong, go to §9 — roll the scene back to the feature before it rather than re-reading the source.

## 7. Make the code read like the drawing

- **Every drawing dimension becomes a named `const` at the top of the file**, named after the drawing's callout or feature. The file then reads as a transcription anyone can diff against the sheet.
- **Derive dependent dimensions instead of retyping them** — `const boltCircleR = plateDia / 2 - edgeMargin;`. A retyped number is a number that will drift.
- **Reference faces, not hand-positioned planes** (see the FluidCAD skill). When the transcribed dimensions change, face-referenced sketches follow; magic-number planes do not.
- **Model nominal.** Where a tolerance or fit actually matters, note it in a comment rather than baking a mid-tolerance value into the geometry — unless the user asks for the fit dimension.
- **Comment what you deliberately did not model** — thread forms, surface finish, GD&T, knurls. Silence reads as an oversight; a comment reads as a decision.

## 8. Verify against the drawing, not against your intent

"It compiled" and "it looks plausible" are both weaker than "it measures what the sheet says."

- **Compare views.** `screenshot_multi` gives front / top / right / iso in one image, in the same arrangement as an orthographic sheet. Put it next to the drawing and check view by view.
- **Measure the numbers.** `measure` on two parallel faces gives an overall dimension or a wall thickness; `get_face_properties` on a cylindrical face gives a hole's `radius`; `get_edge_properties` gives a fillet radius or an edge length. Spot-check every dimension that a downstream feature depends on.
- **`get_shape_properties` is a regression check, not a conformance check.** Volume, area, and centroid are useful for confirming a change had — or did not have — the effect you expected between two renders. They cannot tell you the part matches the drawing.
- **If the user also supplied a STEP reference**, `import_step` it and compare visually against your model.
- **Close the loop at the end.** Walk the dimension inventory from step 1 and tick each entry against a measured value or a modeled feature. Report anything left unaccounted for rather than letting it pass silently.

## 9. When something is wrong, roll the scene back and look at it

When a feature comes out wrong — or a later feature fails because an earlier one was already wrong — do not re-read the source harder. Step the scene back to the state that produced the problem and look.

**Find the index.** `get_scene_summary` returns every scene object with its index, kind, parameters, source location, and the shape ids it produced. That is the map from "the feature I care about" to both the index to roll back to and the line that produced it.

**Roll back and screenshot.** `rollback_to(index)` renders the model up to that step only. It changes render state only — the source file is untouched and the module is not re-run, so it is fast, it is safe, and shape ids stay valid across it. `list_shapes` at a rolled-back state returns only what is rendered up to that index, which is itself a quick check on what a feature actually produced.

Three uses that pay off repeatedly:

- **Inspect the inputs to a failing feature.** Roll back to the index *before* it and screenshot. A fillet that errors, a cut that misses material, or a shell that silently no-ops almost always means the face or edge it was handed was already wrong. With the scene paused there, use temporary `select` / `color` to see exactly what the filter catches at that point in the build.
- **Bisect a part that is wrong at the end.** When the finished model does not match the drawing and you do not know which step broke it, roll back to the middle index, look, then halve again. Two or three screenshots localize the culprit faster than re-reading the file top to bottom.
- **Compare against the drawing at an intermediate stage.** A drawing's views and sections often correspond to a mid-build state, before fillets, chamfers, and shells cover the underlying geometry. Rolling back to that state makes the comparison direct — and lets you `measure` the base dimensions before the dress features moved those faces.

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

## Traps specific to drawings

- **Projection angle flips sides.** In first-angle the view placed to the right shows the *left* side; in third-angle it shows the right. Get this from the title block before deciding which side a feature lives on.
- **Never scale off the image.** On a scan, a photo, or a rendered PDF, only the written dimensions are authoritative. If a dimension is missing, ask — do not measure pixels.
- **Section hatching is material, not a face.** Do not model the cutting plane.
- **Dual-unit drawings**: one unit governs (usually the un-bracketed one). Pick it, say which, and stay in it.
- **`TYP` means it applies to every like feature** — find how many before assuming one.
- **A rounded corner in a 2D view is ambiguous**: a rounded outline is usually a sketch-level fillet, an edge break is usually a 3D fillet or chamfer. They produce different geometry and different edge sets. If the view does not settle it, ask.
- **Drawings under-dimension deliberately.** Centerlines, symmetry marks, and equal-spacing notes carry dimensional meaning — read them as constraints rather than treating the geometry as unspecified.
- **Depth callouts (`↧`) meet the sign convention trap.** `extrude` takes positive along the sketch normal; `cut` takes positive *into* the material. Transcribing a depth straight from the sheet into the wrong one silently produces a feature going the wrong way.

## When the drawing cannot be modeled as drawn

Say so before starting, not after three features:

- Parts that fundamentally need **surface modeling, sheet metal, or 3D curves** are outside FluidCAD's current scope (see the FluidCAD skill's known limitations). Name the limitation and offer the closest solid-modeling approximation as an explicit choice, rather than quietly faking it.
- If the drawing itself is **internally inconsistent** — a chain that does not close, one view contradicting another — stop and surface the conflict. Do not silently pick the interpretation that is easier to model.

## Quick reference: the drawing loop

1. Glance at the drawing; launch the baseline doc sub-agents (wave 1) in one message.
2. Read the whole sheet yourself while they run — title block, views, callouts — and build the dimension inventory. Never split the image up.
3. Ask every open question in one batch. Never guess a number.
4. **Write the build plan in generic CAD terms** — design intent, datums, ordered steps each with its reason, pitfalls specific to this part — and show it to the user.
5. Launch wave 2 of the doc agents: one per operation the plan names. An API that cannot do what a step assumed is a plan change, not a step to bend.
6. Fix origin and orientation on the drawing's datums; align the front view.
7. Build the minimum viable solid, screenshot, show it.
8. Work down the plan's steps, one per write. Screenshot before building on anything complex — filtered, kernel-heavy, patterned, or about to become the next feature's reference. Batch the simple ones and check them at the next checkpoint.
9. Verify with `screenshot_multi` plus `measure` / `get_face_properties` against the sheet.
10. When something looks wrong, `rollback_to` the feature before it and inspect — do not re-read the source. Restore with `recompute` before writing more. Breakpoints are a different, heavier tool: they edit the file and need an editor attached.
11. Close out the dimension inventory; report anything not modeled.

---
name: FluidCAD-from-drawing
description: Turning a 2D engineering drawing into a parametric FluidCAD model. Use this skill whenever the user supplies a drawing, blueprint, dimension sheet, hand sketch, screenshot, PDF, or photo of a part and wants it modeled — "model this", "build this part", "make this in CAD", "here's the drawing". Trigger it alongside the FluidCAD skill any time the FluidCAD MCP tools (`mcp__fluidcad__*`) are available and the geometry is being read off a drawing rather than described in conversation.
---

# Modeling a part from a drawing

This skill layers on top of the **FluidCAD** skill. That one owns everything generic: the MCP loop (read the docs, write the file, check `render.state`, screenshot), parallel doc research with sub-agents, what a build plan contains and how to write it, building in small increments, when a feature earns a verification screenshot, and rolling the scene back to debug. Follow it. This skill covers only what is specific to working from a drawing: reading it correctly, turning it into that plan, and checking the result back against the sheet.

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

Before settling into the careful pass, take one **glance** at the sheet — just enough to see what kinds of features the part has — and launch the baseline doc sub-agents (FluidCAD skill, "Send sub-agents into the docs") so they read while you read.

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

## 3. Turn the drawing into the build plan

The FluidCAD skill defines the plan and how to write it — generic CAD terms, design intent, datums, ordered steps each with its reason, pitfalls called against this specific part, shown to the user before any code exists. Write that plan. What the drawing contributes to it:

- **The dimension inventory is the input to the steps.** Each step names which inventory entries drive it, so the plan and the checklist stay the same document. A dimension that no step claims is a dimension you have not understood yet.
- **The datums come from the sheet, stated in drawing terms** — "datum A is the bottom mounting face; the part is symmetric about the vertical centerline of the front view." §4 turns that into FluidCAD's coordinate system.
- **The base feature is normally the outline of the most informative view**, extruded through the overall thickness.
- **Two extra pitfalls to watch for, both particular to drawings:**
  - **Modeling from the pictorial view.** The isometric shows shape; only the dimensioned orthographic views carry the numbers.
  - **Treating a cosmetic thread callout as real helical geometry** when a plain hole is what is wanted — that is a §2 question, and its answer belongs in the plan.

Show the plan and pause for the user. It is the cheapest artifact in the project to change, and if the user does CAD they can correct the whole approach in one message. From there the plan is the script: it names the operations for the second wave of doc agents, and §5 builds its steps in order.

## 4. The drawing never leaves the main agent

The FluidCAD skill's sub-agent rules apply as written — one agent per API area, read-only, verbatim signatures, verify anything surprising. One rule is specific to this workflow and is absolute:

**Do not hand the image to a sub-agent to "extract the dimensions."** A sub-agent returns a summary, and a summarized dimension is a number stripped of the extension lines, arrowheads, and view that gave it meaning — the same failure that makes cropping unsafe, with a lossy retelling on top. You read the sheet; they read the docs.

## 5. Fix the origin and orientation on the drawing's datums

The FluidCAD skill covers why the origin choice matters and how symmetry pays for itself. Two things are set by the drawing:

- **Put the drawing's datums at the origin.** The datum faces are what every dimension is measured from; placing them at zero makes each dimension appear in the code verbatim, with no arithmetic offsets to get wrong.
- **Align the drawing's front view with FluidCAD's front view.** Then `screenshot_multi` — which returns front / top / right / iso-ftr as a 2×2 grid — can be laid next to the drawing sheet and compared 1:1. Rotating the part into a "nicer" orientation means mentally re-mapping views for the rest of the session, and that is where side-of-the-part mistakes come from.

State the choice in one line before modeling. Correcting it now is free; correcting it after four features is not.

## 6. Build the minimum viable solid first, then show it

The first goal is **not** a finished part. It is the smallest solid that proves **you read the drawing correctly** — normally just the base outline extruded to the overall thickness, and nothing else. Write it, confirm `render.state === "rendered"`, screenshot, and show the user. If the outline or the orientation is wrong, it costs one line to fix at this point.

From there, work down the plan's steps at the cadence the FluidCAD skill sets: one step per write, complex features gated by a screenshot before anything depends on them, simple ones batched two or three at a time. Say what is coming next in drawing terms — "base plate matches the front view; next is the 4× ⌀5 bolt pattern" — so the user can catch a misread before it has dependents.

## 7. Make the code read like the drawing

- **Name each `const` after the drawing's callout or feature**, so the file reads as a transcription anyone can diff against the sheet.
- **Derive dependent dimensions instead of retyping them** — `const boltCircleR = plateDia / 2 - edgeMargin;`. A retyped number is a number that will drift from the sheet.
- **Model nominal.** Where a tolerance or fit actually matters, note it in a comment rather than baking a mid-tolerance value into the geometry — unless the user asks for the fit dimension.
- **Comment what you deliberately did not model** — thread forms, surface finish, GD&T, knurls. Silence reads as an oversight; a comment reads as a decision.

## 8. Verify against the drawing, not against your intent

"It compiled" and "it looks plausible" are both weaker than "it measures what the sheet says."

- **Compare views.** `screenshot_multi` gives front / top / right / iso in one image, in the same arrangement as an orthographic sheet. Put it next to the drawing and check view by view.
- **Measure the sheet's numbers**, not just the ones a later feature depends on: `measure` between parallel faces for overalls and wall thicknesses, `get_face_properties` on a cylindrical face for a hole radius, `get_edge_properties` for a fillet radius or edge length.
- **If the user also supplied a STEP reference**, `import_step` it and compare visually against your model.
- **Rolling back is often the right comparison.** A drawing's views and sections frequently correspond to a mid-build state, before fillets, chamfers, and shells cover the underlying geometry — `rollback_to` that index and the comparison against the sheet becomes direct.
- **Close the loop at the end.** Walk the dimension inventory from §1 and tick each entry against a measured value or a modeled feature. Report anything left unaccounted for rather than letting it pass silently.

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

1. Glance at the drawing; launch the baseline doc sub-agents in one message.
2. Read the whole sheet yourself while they run — title block, views, callouts — and build the dimension inventory. Never split the image up.
3. Ask every open question in one batch. Never guess a number.
4. Write the build plan (FluidCAD skill) with the inventory driving its steps and the drawing's datums as its setup; show it to the user.
5. Launch the plan-derived doc agents: one per operation the plan names. The drawing itself never goes to a sub-agent.
6. Fix origin and orientation on the drawing's datums; align the front view.
7. Build the minimum viable solid, screenshot, show it.
8. Work down the plan's steps at the FluidCAD skill's cadence — one step per write, screenshot-gated where the feature earns it.
9. Verify with `screenshot_multi` plus `measure` / `get_face_properties` against the sheet, rolling back to a mid-build state where the sheet's views correspond to one.
10. Close out the dimension inventory; report anything not modeled.

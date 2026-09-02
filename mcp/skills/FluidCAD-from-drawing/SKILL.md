---
name: FluidCAD-from-drawing
description: Turning a 2D engineering drawing into a parametric FluidCAD model. Use this skill whenever the user supplies a drawing, blueprint, dimension sheet, hand sketch, screenshot, PDF, or photo of a part and wants it modeled — "model this", "build this part", "make this in CAD", "here's the drawing". Trigger it alongside the FluidCAD skill any time the FluidCAD MCP tools (`mcp__fluidcad__*`) are available and the geometry is being read off a drawing rather than described in conversation.
---

# Modeling a part from a drawing

This skill layers on top of the **FluidCAD** skill. That one owns everything generic: the MCP loop (read the docs, write the file, check `render.state`, screenshot), parallel doc research with sub-agents, what a build plan contains and how to write it, building in small increments, when a feature earns a verification screenshot, and rolling the scene back to debug. Follow it. This skill covers only what is specific to working from a drawing: reading it correctly, turning it into that plan, and checking the result back against the sheet.

The governing principle: **a drawing is a specification you are transcribing, not a picture you are approximating.** Every number in the model should trace back to a number on the sheet — printed, or derived from printed ones by construction.

Its corollary: **the sheet is complete and correct.** A released drawing fully determines the part; not every determining dimension is printed, because some are implicit — carried by symmetry marks, centerlines, tangency, concentricity, equal spacing, closed dimension chains. A dimension that seems missing is one you have not derived yet, never a defect in the drawing, and an apparent contradiction between views means you misread one of them. "The drawing doesn't give this" is always a statement about your reading, not about the sheet.

## 1. Every read of the drawing is whole — no cropping, ever

Open the drawing with whatever file/image reading tool your client provides — and for a multi-page PDF, read every page, not just the first.

**Whoever reads the sheet reads the original image, whole** — you and every transcriber alike. Do not crop it, tile it into quadrants, split out a region, zoom-and-slice, or otherwise preprocess it into sub-images to pull the dimensions out. It feels like it should help; it does not:

- **Cropping strips the context that gives a number its meaning.** A dimension is defined by the extension lines it spans, the arrowheads at its ends, and the view it sits in. Isolated in a tile, `24` is just a number with no referent — and that is exactly how a width gets modeled as a depth.
- **Splitting causes both double-counting and omission.** The same dimension shows up in two tiles and gets modeled twice, or it lands on a seam and vanishes from both. Neither failure announces itself.
- **Re-encoding adds no information.** Enlarging a blurry region does not recover pixels the original never had; it produces confident-looking digits that were never on the sheet. A misread you invented this way is indistinguishable from a real reading.

If something is genuinely unreadable at full size, that is a question for the user (§4), not a problem to solve with image processing.

The same ban covers **scripted analysis of the drawing, for any purpose** — no PIL/OpenCV/numpy code, circle or line detection, arc fitting, radial probing, density maps. Not to read values, and not "just for topology or attachment" (which circle a leader touches, which edges an extension line spans): a script that "finds" the answer produces confident-looking geometry with no authority behind it, and writing, debugging, and interpreting one eats the session. All labels on an engineering drawing are printed to be read; you read the sheet with your eyes on the whole image, and anything that reading cannot settle goes down §4's ladder — never through code.

## 2. One structural glance, then a parallel consensus read

Do not transcribe the digits alone, one long careful pass at a time. The read splits into a structural pass you do and a digit-level pass several independent readers do in parallel.

**Your structural glance.** Read the sheet once for what it is, not yet for its numbers:

- **Title block:** units (mm or inch), scale, projection angle (first vs third), general tolerance note, material, revision. These change how you interpret every view. FluidCAD files are in millimetres unless they say otherwise: a drawing in inches is modelled with `unit('in')` as the first statement after the imports, writing the sheet's numbers verbatim (or, for a single imperial dimension in a metric part, `inch(x)` from `fluidcad/units`) — never by multiplying by 25.4 by hand. Confirm the policy with the user up front.
- **Views:** which are orthographic (front/top/right), which are sections, which are detail blow-ups. For a section, note where the cutting plane is — a section shows internal geometry, not an outer face.
- **Dashed lines are hidden geometry** — bores, pockets, and counterbores seen through material; internal features to cut, never outlines to extrude.
- **Callouts** you'll need decoded: `⌀` diameter, `R` radius, `SR` spherical radius, `□` square, `⌴` counterbore, `⌵` countersink, `↧` depth, `THRU`, `TYP`, `4X`, `±`, bolt-circle notation, thread callouts (`M6×1`, `1/4-20 UNC`).

That glance is enough to launch the baseline doc sub-agents (FluidCAD skill, "Send sub-agents into the docs") and to start thinking about the plan.

**The transcribers.** In the same message as those doc agents, launch **three transcriber sub-agents** (two is acceptable for a small, cleanly rendered sheet):

- each gets the drawing's **file path** and reads the whole image itself
- each is told to first read `references/transcription-contract.md` in this skill's folder and follow it exactly — it defines the JSON they produce and the reading rules that bind them
- each gets a reader label (A, B, C) and a distinct output path in your scratch directory (`drawing-read-a.json`, …)
- they work independently — never show one reader another's output

**The merge.** When they return, run the bundled script (no dependencies, Node ≥ 18):

```bash
node <this skill's folder>/scripts/merge-drawing-reads.mjs \
  drawing-read-a.json drawing-read-b.json drawing-read-c.json \
  -o <part>.drawing.json --source <drawing file>
```

It aligns the reads by view + sheet position + callout text and gives every dimension a status:

- **agreed** — every reader, same value. Model from it without re-reading the image.
- **majority** — one dissent, recorded under `variants`. Usable; mention it in the question batch when it drives a functional dimension (a bore, a mating distance).
- **partial** — a reader missed it, or a reader invented it. Verify with one targeted look at the full sheet before modeling it.
- **conflict** — no majority; the entry carries variants and **no value**. Never model it: resolve it with your own whole-sheet look or put it in the question batch.

The merged `<part>.drawing.json` **is the dimension inventory.** Save it next to the model file: the plan's steps cite its ids (`d3`, `d7`), the close-out in §9 walks it entry by entry, and a future session starts from it instead of re-reading the sheet.

**Check the arithmetic on the merged table.** Chained dimensions should sum to the stated overall; hole positions should fall inside the outline; a bolt circle should clear the edge. Reader agreement means the digits were printed that way — not that the sheet is consistent. A mismatch is a §4 question, not something to reconcile by guessing.

**A merge with no conflicts is a green light.** Triage the reader questions (§4), then go straight to the plan and the first solid. Do not spend more time studying the sheet to pre-resolve every residual doubt about what a dimension attaches to: a referent doubt is cheaper and more reliably settled against the 3D model — `measure` and `screenshot_multi` laid next to the sheet — than by another round of image study.

**Fallback.** If your client cannot run sub-agents, or the drawing exists only as a pasted conversation image you cannot hand to one, first ask the user for the file path — a file on disk is what makes the parallel read possible. Failing that, do the full careful read yourself as a single reader and still write the same `<part>.drawing.json` by hand, contract schema and honest confidences included. Everything downstream consumes that file either way.

## 3. What sub-agents may and may not do with the drawing

The FluidCAD skill's sub-agent rules apply as written — doc agents are read-only, verbatim signatures, verify anything surprising. On top of them:

- **Doc agents never get the image.** They read the API docs; the drawing is not their input.
- **Transcribers get the image whole, or not at all.** Never a crop, a single view, or "just read the top half" — §1 binds them identically.
- **Dimensions never cross an agent boundary as prose.** A summarized dimension is a number stripped of the extension lines, arrowheads, and view that gave it meaning — the same failure that makes cropping unsafe, with a lossy retelling on top. Numbers move between agents only as contract JSON, and only merged statuses reach the model.
- **Transcribers write exactly one file: their own output path.** Never the model, and never the MCP scene tools (`write_file`, `edit_range`, `recompute`, `rollback_to`).

## 4. Triage every open point, then ask what survives — batched into one round

**Never guess a digit.** An 8 read as a 3 propagates silently through every downstream feature and is expensive to unwind. But "never guess" applies to *what is printed*, not to every doubt a reader can voice — most reader questions are not user questions. Walk each open point down this ladder, in order:

1. **Drafting convention settles it.** No units stated but the callouts read `M12×1.75` and `110.4` → millimetres. `4X 12 THRU` on a circle in a hole pattern → ⌀12 through-holes. Blank title-block fields (material, scale, title) → genuinely absent, not a mystery to chase. A convention reading is a decision, not a guess: take it, and record it as a one-line `// ASSUMPTION:` comment on the feature it drives.
2. **Derivation settles it — arithmetic, construction, cross-view consistency.** A dimension the sheet does not print is implicit: close the chain (overall minus the printed links), apply the symmetry a centerline declares, place the tangent line two dimensioned arcs fully determine, center what the centerline centers, space equally what the pattern note spaces. These are exact values with a stated derivation — comment the derivation, not an `ASSUMPTION`. The same logic settles referents: unsure which edges a `54` spans? Usually only one candidate makes the chains close and agrees with the other views. Take that reading, mark it `ASSUMPTION`, and let §9's measurements confirm it on the model.
3. **Only what survives 1–2 goes to the user** — genuinely illegible digits, chains that do not close under any reading, contradictions between views.

**If no user is available to answer** — an autonomous run, a benchmark, or the user has said to proceed without them — the ladder is the entire procedure: take the convention/consistency reading, mark it `ASSUMPTION`, keep building, and surface the full assumption list in the final report. Do not stall the build hunting for certainty the sheet does not print, and never turn to image-processing scripts to manufacture it (§1).

The merge report feeds the ladder: every **conflict**, the **partial** entries a targeted look did not settle, **low-confidence** values on functional dimensions, **title-block conflicts**, and the readers' own `questions`. Add what only you can see:

- illegible, cut-off, or ambiguous numbers — ask for a better scan or a higher-resolution copy, and put that new source through the same consensus read, whole. Never try to recover the digits yourself by cropping or upscaling the copy you already have (§1).
- a chain that still refuses to close after re-checking your own reads — evidence of a misread somewhere, and the question is which entry to re-verify, never "the sheet is short a dimension"
- whether threads should be modeled as real geometry or left as plain holes at nominal/tap-drill size
- whether to model nominal dimensions or a specific fit
- which revision governs, if more than one drawing was supplied

A feature the drawing shows but does not print a number for is **not** on this list — it is implicit, and rung 2 of the ladder derives it.

Ask it all as **one consolidated set of questions**, not one unknown at a time. Anything the user answers, write into the code as a comment next to the feature it decided. The next reader will have the same question.

## 5. Turn the drawing into the build plan

The FluidCAD skill defines the plan and how to write it — generic CAD terms, design intent, datums, ordered steps each with its reason, pitfalls called against this specific part, shown to the user before any code exists. Write that plan. What the drawing contributes to it:

- **The dimension inventory is the input to the steps.** Each step names the inventory ids that drive it (`drives: d3, d7`), so the plan and `<part>.drawing.json` stay one checklist. An id no step claims is a dimension you have not understood yet.
- **The datums come from the sheet, stated in drawing terms** — "datum A is the bottom mounting face; the part is symmetric about the vertical centerline of the front view." §6 turns that into FluidCAD's coordinate system.
- **The base feature is normally the outline of the most informative view**, extruded through the overall thickness.
- **Two extra pitfalls to watch for, both particular to drawings:**
  - **Modeling from the pictorial view.** The isometric shows shape; only the dimensioned orthographic views carry the numbers.
  - **Treating a cosmetic thread callout as real helical geometry** when a plain hole is what is wanted — that is a §4 question, and its answer belongs in the plan.

Show the plan and pause for the user. It is the cheapest artifact in the project to change, and if the user does CAD they can correct the whole approach in one message. From there the plan is the script: it names the operations for the second wave of doc agents, and §7 builds its steps in order.

## 6. Fix the origin and orientation on the drawing's datums

The FluidCAD skill covers why the origin choice matters and how symmetry pays for itself. Two things are set by the drawing:

- **Put the drawing's datums at the origin.** The datum faces are what every dimension is measured from; placing them at zero makes each dimension appear in the code verbatim, with no arithmetic offsets to get wrong.
- **Align the drawing's front view with FluidCAD's front view.** Then `screenshot_multi` — which returns front / top / right / iso-ftr as a 2×2 grid — can be laid next to the drawing sheet and compared 1:1. Rotating the part into a "nicer" orientation means mentally re-mapping views for the rest of the session, and that is where side-of-the-part mistakes come from.

State the choice in one line before modeling. Correcting it now is free; correcting it after four features is not.

## 7. Build the minimum viable solid first, then show it

The first goal is **not** a finished part. It is the smallest solid that proves **you read the drawing correctly** — normally just the base outline extruded to the overall thickness, and nothing else. Write it, confirm `render.state === "rendered"`, screenshot, and show the user. If the outline or the orientation is wrong, it costs one line to fix at this point.

From there, work down the plan's steps at the cadence the FluidCAD skill sets: one step per write, complex features gated by a screenshot before anything depends on them, simple ones batched two or three at a time. Say what is coming next in drawing terms — "base plate matches the front view; next is the 4× ⌀5 bolt pattern" — so the user can catch a misread before it has dependents.

## 8. Make the code read like the drawing

- **Name each `const` after the drawing's callout or feature**, and comment the inventory id it consumes — the file then reads as a transcription anyone can diff against the sheet.
- **Derive dependent dimensions instead of retyping them** — `const boltCircleR = plateDia / 2 - edgeMargin;`. A retyped number is a number that will drift from the sheet.
- **Model nominal.** Where a tolerance or fit actually matters, note it in a comment rather than baking a mid-tolerance value into the geometry — unless the user asks for the fit dimension.
- **Comment what you deliberately did not model** — thread forms, surface finish, GD&T, knurls. Silence reads as an oversight; a comment reads as a decision.

## 9. Verify against the drawing, not against your intent

"It compiled" and "it looks plausible" are both weaker than "it measures what the sheet says."

- **Compare views.** `screenshot_multi` gives front / top / right / iso in one image, in the same arrangement as an orthographic sheet. Put it next to the drawing and check view by view.
- **Measure the sheet's numbers**, not just the ones a later feature depends on: `measure` between parallel faces for overalls and wall thicknesses, `get_face_properties` on a cylindrical face for a hole radius, `get_edge_properties` for a fillet radius or edge length.
- **If the user also supplied a STEP reference**, `import_step` it and compare visually against your model.
- **Rolling back is often the right comparison.** A drawing's views and sections frequently correspond to a mid-build state, before fillets, chamfers, and shells cover the underlying geometry — `rollback_to` that index and the comparison against the sheet becomes direct.
- **Close the loop at the end.** Walk `<part>.drawing.json` and tick every id against a measured value, a modeled feature, or an explicit waiver agreed with the user. Report anything left unaccounted for rather than letting it pass silently.

## Traps specific to drawings

- **Projection angle flips sides.** In first-angle the view placed to the right shows the *left* side; in third-angle it shows the right. Get this from the title block before deciding which side a feature lives on.
- **Never scale off the image.** On a scan, a photo, or a rendered PDF, only the written dimensions are authoritative. If a dimension seems missing, it is implicit — derive it (§4 rung 2); do not measure pixels, whether by eye or by script (§1 bans the scripts outright). (The `loc` fields in the inventory align readers; they are never geometry.)
- **Section hatching is material, not a face.** Do not model the cutting plane.
- **Dual-unit drawings**: one unit governs (usually the un-bracketed one). Pick it, say which, and stay in it.
- **`TYP` means it applies to every like feature** — find how many before assuming one.
- **A rounded corner in a 2D view is ambiguous**: a rounded outline is usually a sketch-level fillet, an edge break is usually a 3D fillet or chamfer. They produce different geometry and different edge sets. If the view does not settle it, ask.
- **A dimension that seems missing is implicit, not absent.** Drawings under-dimension deliberately: centerlines, symmetry marks, tangency, concentricity, and equal-spacing notes carry exact dimensional meaning. Read them as constraints and derive the value (§4 rung 2) — never conclude the sheet forgot a number, and never ask for one the geometry already fixes.
- **Depth callouts (`↧`) meet the sign convention trap.** `extrude` takes positive along the sketch normal; `cut` takes positive *into* the material. Transcribing a depth straight from the sheet into the wrong one silently produces a feature going the wrong way.

## When the drawing cannot be modeled as drawn

Say so before starting, not after three features:

- Parts that fundamentally need **surface modeling, sheet metal, or 3D curves** are outside FluidCAD's current scope (see the FluidCAD skill's known limitations). Name the limitation and offer the closest solid-modeling approximation as an explicit choice, rather than quietly faking it.
- If the drawing appears **internally inconsistent** — a chain that does not close, one view contradicting another — the working assumption is that *you* misread, not that the sheet is wrong: re-verify the entries involved with a fresh whole-sheet look before anything else. Only if the contradiction survives that re-read do you stop and surface it, showing both readings. Do not silently pick the interpretation that is easier to model.

## Quick reference: the drawing loop

1. Glance at the sheet — structure, not digits — then in one message launch the baseline doc agents **and** three whole-image transcribers (contract: `references/transcription-contract.md`; distinct scratch output paths; independent).
2. While they run, keep reading the title block and views yourself and start shaping the plan.
3. Merge with `scripts/merge-drawing-reads.mjs` into `<part>.drawing.json`, saved next to the model. Check the arithmetic on the merged table.
4. Triage every open point down the §4 ladder — convention, then arithmetic/cross-view consistency, each taken reading recorded as an `ASSUMPTION` comment. Ask what survives in one batch; with no user available the ladder is the whole procedure. Never guess a printed digit, and never resolve doubts with image-processing scripts.
5. Write the build plan with steps citing inventory ids; show it. Launch the plan-derived doc agents — the drawing never goes to them.
6. Fix origin and orientation on the drawing's datums; align the front view.
7. Build the minimum viable solid, screenshot, show it.
8. Work down the plan's steps at the FluidCAD skill's cadence — one step per write, screenshot-gated where the feature earns it.
9. Verify with `screenshot_multi` plus `measure` / `get_face_properties` against the sheet, rolling back to a mid-build state where the sheet's views correspond to one.
10. Close out `<part>.drawing.json` — every id measured, modeled, or explicitly waived.

# Verification and the final report

Read before declaring any feature or part done. Visual review is diagnostic, never authoritative: every visual concern converts into a deterministic check before it becomes a claim, and the report lists only checks that ran.

## What "done" requires

1. `render.state === "rendered"` on the last write, and `recompute` after any rollback investigation reports `rendered` with an empty `objectErrors`. On an edit to an existing model, `render.changes` names the objects to re-verify (see the modifying reference).
2. Every solid the plan promised exists and is sound: `list_shapes` count matches the intended body count, and `validate` reports `ok: true` over the whole scene. A render and a screenshot say nothing about closure or orientation; an open five-face box and an inside-out solid both look fine. `validate` is the check: `openShell` and `nonPositiveVolume` name the shape and the object that produced it. It does not check self-intersection, and says so in `notChecked`.
3. Every functional dimension in the plan was measured and matches.
4. **No unexplained overlap between bodies.** Whenever the scene renders two or more solids (a multi-body part, several `part()` blocks, an assembly), `interfere` ran on the final state and either `ok: true` or every listed `clashes` / `intraPart` volume is a deviation the user accepted (or, unattended, a `// DEVIATION:` comment plus a line in the report). A shared volume is a defect until it is explained; two bodies that must overlap on purpose (a press fit modelled nominal, a cosmetic thread inside a tapped hole) are the only legitimate explanations. `inconclusive` is not a pass.
5. **Sections were taken through every internal fit** (below) and read against the rule "one colour never sits inside another colour's cap".
6. A screenshot was reviewed for the final state, unless a skip case applies.

## Screenshot skip list

A reviewed screenshot is mandatory for every created or visibly changed part, except:

- **Unchanged geometry.** The edit touched a comment, a constant that no shape depends on, or a `color()`.
- **Inspection-only tasks.** The user asked a question about the model and nothing was written.
- **No valid artifact yet.** The render is on `compile-error`; the picture would be the old scene.
- **A simple feature already batched** under the cadence in the core skill, verified at the next checkpoint.

Do not loop on screenshots. If two views did not settle a doubt, the third will not; convert the doubt into a measurement.

## Visual concern to deterministic check

| Looks wrong | Check with |
| --- | --- |
| Overall size or proportion | `measure` two opposing planar faces (`face().onPlane(...)` filters); compare `get_shape_properties` bounding box against the envelope |
| A hole is the wrong size | `measure` on `face().cylinder()` (reports the diameter), or `get_face_properties` with the index. `cylinder()` is full bores only; a fillet or a rounded corner is `face().cylinderCurve(2 * r)` |
| Hole pattern asymmetric or uneven | `resolve_selection` `face().cylinder(d)` and read each match's center; `measure` between two cylindrical faces for the pitch |
| Boss, rib or standoff floating | `list_shapes` count (an extra body means it did not fuse); `measure` between its base face and the face it should touch (distance 0) |
| Pocket or bore depth | `measure` the pocket floor to the top face (parallel planar faces); a `screenshot` with `hide` on the occluding shape or `highlight` on the floor face when the referent is unclear |
| Bore, blind hole or wall looks wrong | `screenshot` with `section` through the feature's axis, then `measure` the depth (floor face to top face) or the wall (outer face to inner face) |
| Wall thickness after a shell | `measure` an outer face against the matching `s.internalFaces()` face; check `objectErrors` for a shell failure first |
| Fillet or chamfer caught the wrong edges | `resolve_selection` the edge expression and count; `measure` one edge of the result (`edge().arc(r)`) or a fillet face (`face().cylinderCurve(2 * r)`) |
| Pattern direction or count | `resolve_selection` the repeated feature's faces; count and centers of the first and last |
| A feature went the wrong way (cut sign) | `get_shape_properties` volume before and after (via `rollback_to`); `measure` the face the cut should have created |
| A body looks hollow, inside-out, or seems to be missing a face | `validate` on that shape: `openShell` means a free edge, `nonPositiveVolume` means the solid is reversed; `rollback_to` the feature before the finding's `sceneObjectId` and `validate` again to find where it went wrong |
| Sketch on a face is off-center | `screenshot` at the rolled-back index with `showDimensions`; `measure` the sketch-derived face against the face outline |
| Part mis-oriented | `screenshot_multi` with `views` covering front, top and the two opposed isometrics; a face that should be on `+Z` resolves with `face().onPlane("xy", h)` |
| Two bodies or instances overlap | `interfere` (whole scene, or `instanceIds` / `shapeIds` for the pair) and read the shared `volume`; then a `screenshot` with `section` through the pair's common axis and `focus` on the two to see where |
| A fastener bottoms out, breaks into a bore, or its head does not seat | `interfere` names the pair; `measure` the fastener tip face against the hole floor (gap = hole depth minus engagement) and the head underside against the seat face (0) |
| A hole or slot is blocked by a body above it | `screenshot` from the insertion side (`top` for a hole entered from above, `bottom` for a mounting slot): the whole outline must read as background, and a `hide` on the covering body shows how much is lost |

Do not assert a concern is fine because a second screenshot looked fine; run the check.

## Sections: which ones are mandatory and how to read them

A section screenshot (`screenshot`, `screenshot_multi` or `measure` with `image.section`) cuts the model on a plane and caps every cut face in its body's colour. It is the only picture that shows what is happening inside a fit, and it is worthless when everything is the same grey. Two rules make it work:

- **Colour first.** Every body that meets another body carries its own colour before any section is read (core skill, "Colour every body that meets another body"). With distinct colours a section reads at a glance: a hole is background, a fit is two colours touching, an overlap is one colour drawn inside another colour's cap.
- **Cut through the axis, look square on.** For a hole, bore, pin or fastener at `(x, y)` along Z put the plane through its axis: `{ plane: "xz", offset: y }` viewed from `front`, or `{ plane: "yz", offset: x }` viewed from `right`. For a bore along Y, `{ plane: "xz", offset: 0 }` from `front` shows the ring of parts around it. Isometric sections hide overlaps behind perspective; use them only after the square-on section is clean.

**Mandatory sections** (not "when in doubt"): before declaring done, take one through

- every blind hole, counterbore and tapped hole (floor, step, and what the fastener does at the bottom);
- every bore that carries another part (bearing, bushing, pin, shaft), showing every part in the stack;
- every fastener, through its own axis, showing head, seat, clearance hole, engagement and tip;
- every wall left by a shell or an offset;
- and, in an assembly, one through each mate axis with the two mated instances in `focus`.

**Reading a section.** Look for, in this order: (1) a colour region continuing across another body's cap boundary (overlap: an `interfere` clash to localize, not a rendering artefact); (2) a fastener whose shank cap touches the hole wall on both sides (no clearance where clearance was asked) or whose tip cap ends below a blind hole's floor (bottoming); (3) a hole reading as background where a solid should be, or as solid where the hole should be (wrong cut sign, cut missed); (4) a part sitting off-centre in its bore (mate or connector offset wrong); (5) a thin sliver of background between faces that should touch (seat not seated, split faces apart).

A section shows whether the fit is there and roughly where; it does not measure it. Convert every finding into the `measure` or `interfere` call from the table before it becomes a claim.

## Report only checks that ran

Every claim in the report maps to a tool result in this session. "Measured 40.00 between the mounting faces" requires a `measure` call that returned it. If a check was skipped, say it was skipped and why. A check that failed is reported as failed, not weakened or waived: a fillet reduced from 6 to 4 to make it build is a deviation, stated as one.

## Never claim

Unless that analysis was actually performed with a tool that does it (and none of the FluidCAD MCP tools do), never claim:

- structural adequacy, load capacity or safety factor;
- tolerance or fit compliance (only nominal geometry is modeled);
- manufacturability, printability or draft adequacy;
- compliance with a named standard;
- watertightness or valid topology beyond what `validate` reported in this session, and never freedom from self-intersection, which no tool checks;
- that two bodies or instances do not interfere, unless `interfere` ran on the final state at the mated poses and reported `ok: true` (a screenshot, or a section, is never that evidence);
- that the model matches a drawing dimension you did not measure.

Say what you checked and what you did not.

## Final report template

```
Model: <file path>            Unit: <unit from get_scene_summary>
Render: rendered | build-error (<n> objectErrors listed below)
Solids: <count> (<names or scene object ids>)
Validate: ok | <n> findings (<kind> on <object>, listed below)
Interfere: ok (<n> units, <n> pairs checked) | <n> clashes / <n> intraPart (each: pair, volume, fix or accepted deviation) | inconclusive (<reason>) | not run (single body)
Sections reviewed: <plane and offset per fit, e.g. "xz@0 front through the bore; yz@±22 right through each screw">

Plan steps: <n> planned, <n> built, <n> deviated (listed)
Assumptions (each is a // ASSUMPTION: comment in the file):
  - <assumption>
Spec conflicts found before building (each is a // DEVIATION: comment in the file):
  - <the two numbers that cannot both hold, what was done instead, what to confirm>
Deviations from the request:
  - <what, why, what was done instead>

Measured (tool result in this session):
  - <what> = <value unit> (asked: <value>)  ok | off by <delta>
Not measured / not verified:
  - <what, why>
Visual review: <views looked at>; concerns converted to checks: <list or none>

Known limitations / remaining risk:
  - <what a downstream user should check>
Outputs: <export paths, if any>
```

Keep it short; the template is a checklist, not an essay. Drop sections that are empty, except "Not measured" when anything functional was not.

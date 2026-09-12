# Verification and the final report

Read before declaring any feature or part done. Visual review is diagnostic, never authoritative: every visual concern converts into a deterministic check before it becomes a claim, and the report lists only checks that ran.

## What "done" requires

1. `render.state === "rendered"` on the last write, and `recompute` after any rollback investigation reports `rendered` with an empty `objectErrors`. On an edit to an existing model, `render.changes` names the objects to re-verify (see the modifying reference).
2. Every solid the plan promised exists and is sound: `list_shapes` count matches the intended body count, and `validate` reports `ok: true` over the whole scene. A render and a screenshot say nothing about closure or orientation; an open five-face box and an inside-out solid both look fine. `validate` is the check: `openShell` and `nonPositiveVolume` name the shape and the object that produced it. It does not check self-intersection, and says so in `notChecked`.
3. Every functional dimension in the plan was measured and matches.
4. A screenshot was reviewed for the final state, unless a skip case applies.

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
| Two instances collide (assembly) | No interference tool yet: `measure` the two nearest faces with their `instanceId` (statement poses) and inspect a screenshot with `focus` on the pair |

Do not assert a concern is fine because a second screenshot looked fine; run the check.

## When a section is worth taking

Take a section screenshot when the geometry in doubt is inside the part: a blind hole's floor, a counterbore step, a wall left by a shell, a boss that should be hollow. Put the plane through the feature's axis (`{ plane: "xz", offset: y }` for a hole at y) and view it square on; the cut faces are capped, so a solid reads solid and a hole reads hollow. A section shows whether the feature is there and roughly where; it does not measure it. Follow it with the `measure` call from the table.

## Report only checks that ran

Every claim in the report maps to a tool result in this session. "Measured 40.00 between the mounting faces" requires a `measure` call that returned it. If a check was skipped, say it was skipped and why. A check that failed is reported as failed, not weakened or waived: a fillet reduced from 6 to 4 to make it build is a deviation, stated as one.

## Never claim

Unless that analysis was actually performed with a tool that does it (and none of the FluidCAD MCP tools do), never claim:

- structural adequacy, load capacity or safety factor;
- tolerance or fit compliance (only nominal geometry is modeled);
- manufacturability, printability or draft adequacy;
- compliance with a named standard;
- watertightness or valid topology beyond what `validate` reported in this session, and never freedom from self-intersection, which no tool checks;
- that two assembly instances do not interfere;
- that the model matches a drawing dimension you did not measure.

Say what you checked and what you did not.

## Final report template

```
Model: <file path>            Unit: <unit from get_scene_summary>
Render: rendered | build-error (<n> objectErrors listed below)
Solids: <count> (<names or scene object ids>)
Validate: ok | <n> findings (<kind> on <object>, listed below)

Plan steps: <n> planned, <n> built, <n> deviated (listed)
Assumptions (each is a // ASSUMPTION: comment in the file):
  - <assumption>
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

# Repair loop

Read the moment `render.state` is not `rendered`, or a write is refused. Classify the failure from what the MCP actually returned, make the smallest responsible change, rerun, rerun the checks that depended on the changed feature, and report what risk remains.

The loop:

1. **Read the failure as returned.** `render.state`, `render.compileError`, `render.objectErrors[].message` and `sourceLocation`, or the refusal `code` and `details`. Do not paraphrase it to yourself before classifying it.
2. **Classify** with the tables below.
3. **Smallest responsible change.** One cause, one edit. Do not also "tidy up" nearby code; a second change hides which one fixed it.
4. **Rerun.** The write itself re-renders; after a `rollback_to` investigation call `recompute`.
5. **Rerun dependent checks.** Any `resolve_selection`, `measure` or screenshot taken downstream of the edited feature is stale.
6. **Report remaining risk.** A feature you worked around (smaller radius, chamfer instead of fillet) goes in the report, not silently into the model.

## Write refused (nothing rendered)

| `code` | Cause | Fix |
| --- | --- | --- |
| `missing-imports` | A FluidCAD symbol is used without an `import { … } from "fluidcad/…"` line | Paste `details.suggestion` at the top of the file |
| `unit-statement` | `unit()` is not top-level, not first, repeated, not a string literal, or sits in a `*.assembly.js` file | Move it directly after the imports, once, as a literal; delete it from assembly files (`details.diagnostics` lists each violation, 0-based line) |
| `dirty-buffer` | The editor has unsaved changes for the file | Show `details.dirtyFiles` to the user; retry with `force: true` only when they say so |
| `invalid-input` | A path outside the workspace, a missing file, a bad argument | Fix the call; nothing reached the scene |

## `render.state` values

| `state` | What happened | What is being served | Next step |
| --- | --- | --- | --- |
| `rendered` | Module ran, every feature built | The new scene | Verify |
| `compile-error` | Module never ran | The previous scene | Read `render.compileError` (or `get_compile_error`), fix, rewrite |
| `build-error` | Module ran; one or more features failed to build | The new scene, missing that geometry | Fix every entry in `render.objectErrors` |
| `superseded` | Another render started before this one settled (the user is typing, or a second write raced) | Whatever finished last | `wait_for_idle`, then `recompute` and read its `state` |
| `no-scene-manager` | No file is open for rendering in this workspace | Nothing | Open or name the file; check `list_fluid_files` and the workspace path |
| `render-failed` | The render pipeline itself failed | Unknown | `recompute` once; if it repeats, report it with the message, do not loop |

## `compile-error`: classes by message

| Message shape | Likely cause | Smallest fix |
| --- | --- | --- |
| `SyntaxError: …` with a `sourceLocation` | Unbalanced braces from a partial `edit_range`, a stray character | `read_file` around the 1-based line, repair only that span |
| `ReferenceError: X is not defined` | A symbol not imported (a name the import guard does not know), or a variable used before its `const` | Add the import or move the declaration; check the guard's suggestion list for the module (`fluidcad/core`, `fluidcad/filters`, `fluidcad/constraints`, `fluidcad/units`) |
| `TypeError: … is not a function` | Wrong accessor or chain on a feature (`e.endFace()` for `e.endFaces()`), a method that exists on another type | `get_api_signature` / `get_type_definition` for the receiver; use the documented name |
| `param('…') must be declared inside a part() body` | `param()` at file top level | Wrap the model in `part("Name", () => { … })` and export it, or replace the `param()` with a `const` |
| A thrown error naming `unit(` | `unit()` placement | Same as `unit-statement` above |
| An error thrown inside a sketch callback (`rotate` is 3D-only, `select(face()…)` inside a sketch, 2D booleans) | A 3D statement used in 2D | Use constraints (`angle`, `horizontal`, `vertical`) or `copy("circular", …)` in the sketch; move the boolean outside |
| A thrown error from `mate()`, `insert()`, `replicate()` outside a `*.assembly.js` file | Assembly statement in a part file | Move it to the assembly file; see the FluidCAD-assembly skill |

On a compile error the previous scene is still being served. Do not screenshot or measure until the state is back to `rendered` or `build-error`.

## `build-error`: classes by `objectErrors[].message`

Each entry names the feature (`name`, `uniqueKind`), the message, and a 1-based `sourceLocation`. The rest of the model rendered; the failed feature's geometry is missing, and the solid it would have modified is served unmodified.

| Message | Likely cause | Smallest fix | Rerun |
| --- | --- | --- | --- |
| `fillet: no edges selected — nothing was filleted.` (same for `chamfer:`, `shell: no faces selected`) | Bare `fillet(r)` with no selection in front of it; a `select()` separated from it by another statement | Pass the target explicitly (`fillet(r, e.endEdges())`) | The feature and anything after it |
| `fillet: the selection resolved to no edges — nothing was filleted.` (`chamfer:` / `shell: … no faces`) | The filter matched nothing at that point in the tree: wrong plane offset, wrong diameter, a face already removed, a filter written at the wrong part scope | `rollback_to` the index before the feature, `resolve_selection` the expression at the statement's scope, adjust until `count` is right, write that expression | `recompute`, then the dependent checks |
| `fillet: could not fillet the selected edges — the radius may be too large for the adjacent geometry.` | Radius larger than an adjacent face or wall, tangency trouble at a corner | Reduce the radius, split the edge set into two fillets, fillet before an intersecting feature, or use `chamfer` | The feature; re-measure the wall it touches |
| `fillet: N selected edge(s) matched no solid in the scene and were skipped.` (`shell: N selected face(s) …`) | The edges belong to a body a later boolean consumed, or to a different part | Re-select on the final body at that scope; inside a part, only that part's faces are candidates | The feature |
| `shell: could not hollow the solid — wall offset failed.` | Wall thicker than a nearby feature or radius of curvature; a cut or groove opens onto a removed face | Thinner wall, fewer or simpler open faces, shell before cutting small features | The shell and every feature after it |
| A `repeat` refusing its options | `count` alone, or both `offset` and `length` | Exactly one of `offset` / `length` (`angle` for circular) | The repeat |
| A boolean, sweep, loft, revolve or draft error without a specific hint | Kernel refused the inputs: a self-intersecting profile, a path leaving the profile plane, a revolve axis not in the sketch plane, a draft on a non-planar face | `rollback_to` the index before it, screenshot the inputs, fix the input rather than the operation | The feature and everything after |

Never report the model as done with a non-empty `objectErrors`. If a feature cannot be made to build, remove it from the plan visibly and say so in the report.

## Rendered, but wrong

No message to key on; the verification table in `references/verification.md` converts what looks wrong into a check. The usual classes:

- **Wrong overall size or bounding box.** A unit mismatch (`unit` in `get_scene_summary` versus the numbers you wrote), a diameter written as a radius, a symmetric extrude doubling the span.
- **A feature is missing.** A `cut` going the wrong way, a filter over-matching into the wrong face, a feature after a `.new()` that did not fuse.
- **A selection that drifted.** Indices from a previous scene summary reused after an edit; a filter written before a feature that changed the face set. Re-resolve.
- **Wrong direction or side.** Pattern sign, `cut` sign, first sketch on a new plane with the in-plane axes assumed. `rollback_to` the first feature on that plane and look.
- **A body that is not a body.** `validate` reports `openShell` or `nonPositiveVolume` on a shape that rendered without complaint. The finding names the object; `rollback_to` the feature before it and `validate` again until the first unsound step is found.

Bisect with `rollback_to` when you do not know which step broke it; two or three screenshots localize the culprit faster than re-reading the file.

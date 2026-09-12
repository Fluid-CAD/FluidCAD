# Modifying an existing model

Read when the task starts from a file that already exists rather than from a blank one. The goal is a surgical edit that keeps the user's structure and style, verified only as far as the change reaches.

## Read before you touch

1. **Read the whole file.** `read_file`. Note the unit (`unit()` or the project's `fluidcad.json`), the named constants at the top, the naming style, quote style, indentation, and whether the model is wrapped in `part()`.
2. **Map features to lines.** `get_scene_summary` gives every scene object with its `index`, `kind`, `params`, `sourceLocation` (1-based line) and `shapeIds`, plus `hasError`. That is the map from "the boss the user means" to the statement that built it and to the index you can roll back to.
3. **Understand by rolling back, not by reading harder.** `rollback_to` the index before the feature you will change and screenshot; `resolve_selection` any filter the feature uses with `before` = the feature's index, which evaluates it in the same world. Then `recompute` before editing.
4. **Fingerprint what must not change.** `get_shape_properties` (volume, bounding box, centroid) on every solid the edit should leave alone; `list_shapes` for the body count. Compare after.

## Edit surgically

- **`edit_range` for a local change, `write_file` for a restructure.** `edit_range` takes 0-based `{ line, column }` positions; the scene summary's line is 1-based, so subtract one. Re-read the lines you are replacing immediately before the edit so the range is exact.
- **Change one thing per write.** The render outcome then answers one question.
- **Keep the user's style.** Their constant names, their comment voice, their quote style, their order of imports. Add an import only when the guard asks (`missing-imports` with `details.suggestion`); do not reorder existing ones.
- **Add to the constants, do not inline.** A new dimension becomes a named `const` beside the existing ones, derived from them where it depends on them.
- **Do not reformat.** No re-indentation, no trailing-whitespace cleanup, no reflowing comments. A diff the user cannot read is a diff they cannot trust.
- **Respect dirty buffers.** A `dirty-buffer` refusal means the user has unsaved edits in the editor. Show them `details.dirtyFiles` and wait; never `force` on your own.
- **Respect the tree order.** Inserting a feature earlier than the features that reference the geometry it changes will shift their selections; check every filter downstream of the insertion point with `resolve_selection` (each at its own `before`) after the edit. A selector you insert goes in as `synthesized.source`, resolved with `before` = the index of the statement it lands in front of.

## Re-verify only what the edit touched

Read `render.changes` after every write (`write_file`, `edit_range`) and `changes` after `recompute`. It lists what the render rebuilt, added and removed, with the bounds of each object's solids before and after, and how many objects were reused untouched. Rebuilt is the re-verification list. An object you did not mean to change appearing under rebuilt with different bounds is the signal that the edit reached further than intended, usually through a face or edge a later feature sits on; re-measure it before moving on. Same bounds under rebuilt means the geometry was built again unchanged. The bounds are exact, volumes are not included; `get_shape_properties` on the named objects gives those.

- The written feature: `render.state`, `objectErrors`, a screenshot if the feature earns one under the core cadence.
- Everything downstream of it in the tree: `resolve_selection` counts for its filters, `measure` for the dimensions it drives.
- The fingerprints from step 4: unchanged solids report the same volume and bounding box; the body count is the same unless the change was meant to add or remove a body.

Do not re-verify the parts of the model the edit could not reach; report the scope of the verification instead ("re-measured the bore and the two faces the new pocket touches; the rest of the model was not re-measured").

## Handing it back

State the change in one sentence, the lines it touched, the assumptions you took, and the verification scope. If the model had pre-existing `objectErrors` you did not fix, list them separately so they are not mistaken for regressions.

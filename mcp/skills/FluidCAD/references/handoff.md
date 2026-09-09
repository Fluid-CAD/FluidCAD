# Handing the model off

Read when the user wants an STL, a STEP, a shareable package, or asks how to use what was built.

## Before any export

The export is of the scene as served. Confirm `render.state` is `rendered` with no `objectErrors`, `recompute` if a rollback is in effect, and run the checks in `references/verification.md`. An export of a model with a failed fillet is a model without that fillet.

## STL, for printing

- `export` with `format: "stl"` and the `shapeIds` from `list_shapes` (or `assembly: true` in an assembly file, which flattens every placed part into one mesh).
- **Units.** STL carries no unit. By default the mesh is scaled into millimetres, which is what slicers expect, whatever the document unit; `scaleTo: "document"` keeps the document's numbers when the consumer wants them. Say which one you used.
- **Resolution.** `"medium"` by default. `"fine"` is the cleanest mesh and slow; use it when the user asks for fidelity or the part has small curved features that print. `"coarse"` for a quick fit check only.
- **Where.** Always pass `saveAsPath` (inside the workspace). The encoded bytes can be multi-megabyte and must not round-trip through the conversation.
- **Orientation** is a slicer decision, not a model decision. Do not rotate the model for printing; mention the intended print orientation in the report if the design assumed one (overhangs, a flat base).

## STEP, for sharing and other CAD tools

- `export` with `format: "step"`, `saveAsPath`, and `includeColors: true` when the colors carry meaning.
- STEP files carry their unit, so the export is physically correct in any document unit; no scaling option applies.
- In an assembly, `assembly: true` writes one STEP assembly: shared part prototypes, one component per instance, sub-assemblies nested, names carried. The result's `posesSource` is `"statement"`: parts sit where their `insert().translate()/.rotate()` statements put them, because mates are solved in the viewer, which the server never sees. Tell the user; the viewer's own Export writes the mated layout.

## A package, for reproducing the model elsewhere

`pack_model` produces a self-contained `.fluidpkg`: the entry file bundled, STEP assets in the workspace, the live param overrides, the camera, and the units (project unit and per-file `unit()` declarations in its manifest). Use it when the user wants to send the model as a model rather than as geometry, or to archive the exact state. Pass `saveAsPath`.

## What to hand back

- The absolute path of every file written, its format, its resolution or color option, and for STL which scaling was used.
- The unit of the source model and the unit of the export.
- The final report from `references/verification.md`, including the assumption list.
- The source file path. The `.fluid.js` / `.part.js` file is the model; the exports are derived from it and should be regenerated from it after any change.

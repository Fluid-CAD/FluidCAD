# Handing the model off

Read when the user wants an STL, a STEP, a DXF or SVG drawing, a package of their features and parts, or asks how to use what was built.

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
- In an assembly, `assembly: true` writes one STEP assembly: shared part prototypes, one component per instance, sub-assemblies nested, names carried. The result's `posesSource` is `"solved"`: every part sits where the mates put it, as the engine solves them from the `insert().translate()/.rotate()` poses. `"statement"` means the mates could not be solved and parts sit on those poses: tell the user. A mechanism the user has dragged to another position exports that position only from the viewer's own Export.

## DXF, for laser cutting, routing and 2D CAD

- `export` with `format: "dxf"`, the `shapeIds` of the solids to draw, a `plane`, and `saveAsPath`. The file is a 2D drawing, not the solid: the shapes as seen on that plane with hidden lines removed, as real lines, arcs, circles, ellipses and splines.
- **Plane.** `plane` is required and names the view: `top` (looking down the Z axis), `bottom`, `front` (from the −Y side), `back`, `right` (from the +X side), `left`; `xy`, `-xy`, `xz`, `-xz`, `yz`, `-yz` are the same six. For a flat part, pick the plane it lies on: a plate sketched on XY and extruded is cut from its `top` view. One export per view, each file named after it (`plate-top.dxf`).
- **Coordinates and units.** The drawing keeps model coordinates in the document's unit and declares that unit; nothing is recentred or scaled. A point at (12, 7, z) is at (12, 7) in a top view.
- **Layers.** Visible edges and silhouettes are on `VISIBLE`. `hiddenLines: true` adds the edges behind the model, dashed, on `HIDDEN`; `tangentEdges: true` adds smooth edges such as a fillet's borders on `TANGENT`. Leave both off for a cutting outline: a cutter follows every line it is given.
- **Several shapes** are drawn together, the nearer hiding the farther. To cut parts separately, export each on its own.
- `resolution`, `includeColors` and `scaleTo` belong to the 3D formats and are refused here. `assembly: true` in place of `shapeIds` draws the whole assembly, every part where it sits, one hiding another.
- If the result has `warnings` (curves that had to be approximated by polylines), tell the user.
- A drawing is checked like a model: it shows what the view shows. Look at the same view with `screenshot` (`view: "top"`, …) before handing it over; a feature on the far side is not in the outline.

## SVG, the same drawing for laser software, documents and the web

- `export` with `format: "svg"` takes what DXF takes (`shapeIds`, `plane`, `hiddenLines`, `tangentEdges`) and draws the same view: same planes, same hidden-line removal, same curves. Use DXF for CAD and CAM tools, SVG for laser software that prefers it, a document, a web page. Name the file after the view (`plate-top.svg`).
- **Size.** One SVG unit is one document unit, and the page's `width` / `height` give it its physical size (mm for a metric document, in for an imperial one): it prints and cuts 1:1.
- **Coordinates.** SVG's Y runs down the page. X is the model's own; Y is measured down from the drawing's top edge, so a point at height `y` in the view is written at `top − y`. The picture is the right way up.
- **Page.** `strokeWidth` (default 0.25) is the stroke of the visible edges and `margin` (default 5) the blank band around the drawing, both in millimetres on paper whatever the document's unit; both are refused with any other format. Hidden and tangent edges are drawn at half the stroke. `margin: 0` makes the `viewBox` the drawing's exact bounds.
- **Layers** are groups: `<g id="visible">`, `<g id="hidden">` (dashed), `<g id="tangent">`, which Inkscape opens as layers. Each joined outline is one `<path>` (`L` straight sides, `A` arcs, `C` / `Q` splines, `Z` closing a loop); a full circle is a `<circle>`.
- **Reading it back.** Without `saveAsPath` the result holds the SVG source in `text`. It is small and exact, so it is a quick way to check a profile yourself: the paths list the outline's corners, arc radii and hole centres in the model's own numbers. Still pass `saveAsPath` for the file the user gets.
- The file holds no script, style sheet or external reference. `warnings`, the 3D options and `assembly: true` behave as for DXF.

## A package, for sharing features and parts

`pack` packs the workspace's package into a `.fluidpkg`, to look at what would be published without publishing: the modules in the package's `features/`, `parts/` and `assemblies/` folders (the folders decide the exports; there is no exports list), the files they import, their features' images, and a generated `manifest.json`, `index.js` and `fluidcad.json` (the unit and materials). It is not a model export: test models outside the three folders stay out. Use it when the user wants to share the features or parts they built, in a workspace that is a package (`fluidcad package init` writes the block). Pass `saveAsPath`, named as the result's `fileName` (`<scope>-<name>-<version>.fluidpkg`). A `pack-refused` result names the file to fix (a module in the wrong folder, an import that leaves the folders, …); fix it and pack again. It is never a step before publishing: `fluidcad publish` packs the workspace the same way itself and uploads it to the hub, from which others install it (the archive itself never installs). To release a new version, bump it with `fluidcad version patch|minor|major` first.

To send a model itself, export STEP (above) or share the source files.

## What to hand back

- The absolute path of every file written, its format, its resolution or color option, for STL which scaling was used, and for a DXF or SVG which view it shows.
- The unit of the source model and the unit of the export.
- The final report from `references/verification.md`, including the assumption list.
- The source file path. The `.fluid.js` / `.part.js` file is the model; the exports are derived from it and should be regenerated from it after any change.

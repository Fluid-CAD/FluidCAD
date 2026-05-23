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

## Designing the part

Before writing any code, agree with the user on the plan:

1. **Restate the requirements.** Confirm what the part is for and what features it must have.
2. **Pin down dimensions and tolerances.** Surface anything ambiguous now, not after modeling.
3. **Decompose into simple features.** Break the part into a sequence of base + additive + subtractive operations that map cleanly to FluidCAD primitives.
4. **Define the origin and orientation.** Pick a coordinate system that makes downstream features easy (symmetry on an axis, the most-referenced face on a standard plane, etc.).
5. **Plan the order of operations.** A feature ordering that is wrong (e.g., fillets before the holes that intersect them) is painful to undo. Walk through the order before coding.
6. **Confirm the plan with the user before each major step.** Especially on the first feature and on any step where you made a non-obvious choice. It is far cheaper to course-correct on a sketch than after three dependent features.

## Writing the code

- `.fluid.js` files must import every FluidCAD symbol they use. `write_file` and `edit_range` reject files missing imports with code `missing-imports`; the error's `details.suggestion` is a paste-ready import block — use it.
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

## After writing the code

`write_file` and `edit_range` are synchronous — they return once the render settles. Check the outcome carefully:

1. **Check the render state.** If `render.state !== "rendered"`, the scene is not yet showing your change. On `compile-error`, the previous scene is still being served — read `get_compile_error`, fix the source, and retry. Do not call `screenshot` or inspection tools on a broken compile; you will be looking at the old scene.
2. **Verify visually.** Once the file compiles cleanly, take a `screenshot` (or `screenshot_multi` from several angles, or `screenshot_shape` for a specific shape) and confirm the geometry matches intent. "It compiled" is not the same as "it looks right."
3. **Use shape volume only as a regression check.** `get_shape_properties` (volume/mass/etc.) is the right tool when you want to compare against a previous state to confirm a change had — or did not have — the effect you expected. It is not a substitute for actually looking at the screenshot.

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

## Handling unsaved-buffer conflicts

`write_file` and `edit_range` refuse to clobber a buffer the editor has unsaved changes for (code `dirty-buffer`). Surface the conflicting paths to the user and ask before retrying with `force: true` — overwriting their in-progress work without checking is a serious failure mode.

## Known limitations

FluidCAD currently does **not** support:

- **3D curves** — work around this by sketching on multiple planes and combining the results.
- **Helices** — there is no built-in helix; for thread-like geometry, discuss the workaround with the user before attempting it.
- **Surface modeling and sheet metal** — these are out of scope. If the user's request fundamentally needs them, say so up front rather than trying to fake it with solids.
- **3D text** — there is no built-in way to extrude text into geometry. If the user needs raised or engraved lettering, surface this limitation before attempting a workaround.

## Quick reference: the loop

For every modeling step, the rhythm is:

1. Read the relevant docs (`search_docs` / `read_doc` / `get_api_signature` / `get_type_definition`).
2. Agree on the step with the user.
3. Write the code with all required imports.
4. Check `render.state` — fix compile errors before going further.
5. Screenshot and verify visually.
6. Use temporary `select` / `color` to sanity-check filters before depending on them.
7. Move on to the next feature.

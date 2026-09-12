---
name: FluidCAD-assembly
description: "Building multi-part models in FluidCAD: assemblies, part files, inserting and mating parts, connectors, exposed geometry, part parameters, sub-assemblies, replicated instances, STEP parts, project units, and assembly export. Use this skill whenever the user wants an assembly, a mechanism, a hinge, a slider, several parts that fit or move together, a `.assembly.js` or `.part.js` file, `insert()`, `mate()`, `connector()`, `expose()`, `replicate()`, instances, or asks to split a model into parts. Trigger it alongside the FluidCAD skill any time the FluidCAD MCP tools (`mcp__FluidCAD__*`) are available and more than one part is involved."
---

Provenance: maintained in the FluidCAD repo (`https://github.com/Fluid-CAD/FluidCAD`), under `mcp/skills/`. The installed local skill files are the runtime source of truth.

# Assemblies in FluidCAD

This skill layers on top of the **FluidCAD** skill. That one owns the loop: read the docs, plan in generic CAD terms, build in increments, check `render.state` and `objectErrors`, resolve filters before writing them, screenshot when a feature earns it, roll back to debug, and report only what was checked. Follow it for every part. This skill covers only what is specific to models made of several parts: when to split, how a part publishes its interface, how an assembly places and joins instances, and how to verify the result.

The governing principle: **a part is verified alone before it is inserted, and mates are added one at a time.** An assembly is where three parts' mistakes meet; keep the mistakes out of it.

## 1. When to split a model into parts

Split when the pieces are **separate physical components**: things fabricated separately, bought (a bolt, a bearing, a rail), moving relative to each other (a lever on a pin, a carriage on a rail), or reused with different parameters (four standoffs of two heights). Features of one machined or printed body (holes, ribs, fillets) are never parts.

Two rules from the API decide the mechanics:

- Inside a `part()`, shapes auto-fuse with each other and never with anything outside it. Two solids that touch but must stay separate go in two parts. Inside one part, `.new()` keeps a feature as a separate body.
- Only an **exported** `part()` can be inserted. A standalone model needs no `part()` at all.

Convention: one part per `.part.js` file, named after the thing it is (`bracket.part.js` exports `bracket`); one `.assembly.js` file per mechanism. Several components in one file each get their own `part()`, but that file cannot be inserted piecemeal with the same clarity, so prefer one file each.

## 2. Files and units

| suffix | scene | contents |
|--------|-------|----------|
| `.part.js` | part | modelling statements; `export const x = part("X", () => { … })` when an assembly will insert it |
| `.assembly.js` | assembly | `export const x = assembly("x", () => { insert(); mate(); … })` |
| `.fluid.js` | part | legacy suffix, same as `.part.js` |

Units belong to parts:

- A part's numbers are in its file's unit: `unit('in')` directly after the imports, else the `"unit"` in the nearest `fluidcad.json`, else `mm`.
- An assembly never calls `unit()` (the write guard refuses it, code `unit-statement`). Every length the assembly file owns, `.translate()`, mate `.offset()` and `.limits()`, is in the **project unit**.
- Inserted parts are scaled from their file's unit into the project unit automatically, connectors included. An inch part in a mm project comes out at 25.4 times its inch numbers with nothing to write.
- `insert(def, { Length: 10 })` overrides are read in the **part's** unit, whatever the assembly's. The `inch()` / `mm()` helpers do not help here; they convert into the calling file's unit, which is the assembly's.

Before trusting any number, read `unit` from `get_scene_summary` for the file that is open.

## 3. Part-local origin conventions

The part's origin is its mating interface. A dimension measured from that interface then appears in the code verbatim, and the connector at the origin needs no offset.

- **A plate or base**: bottom (mounting) face on `z = 0`, outline centered on the origin when the part is symmetric, otherwise a datum corner at the origin.
- **A pin, shaft, standoff, bolt**: axis on Z, the seating face (head underside, foot) on `z = 0`.
- **A lever, link, bracket**: the pivot bore axis on Z through the origin; the arm extends along +X.
- **A carriage or slider**: the sliding face on `z = 0`, travel along X.
- **A symmetric part**: the symmetry plane through the origin, so mirrored features are free and the connector on the symmetry plane is at `x = 0`.

State the convention in one line before writing the part, exactly as the core skill asks for a single part. The assembly's starting poses (`.translate()`) become readable when every part's origin is where it mates.

## 4. A part's interface: `param()`, `connector()`, `expose()`

| statement | direction | read back as |
|-----------|-----------|--------------|
| `param("Label", default, type?, opts?)` | values in | `insert(def, { Label: value })` |
| `connector("name", geometry)` | mate frames out | `instance.connectors.name` for `mate()` |
| `expose("name", sceneObject)` | geometry out | `def.features.name` (another part builds on it), `instance.features.name` (a tangent mate touches it) |

Rules that trip up every first attempt:

- `param()` is only valid inside a `part()` or `assembly()` body; at file top level it throws. Declare parameters at the top of the body, before the geometry that uses them.
- `connector()` and `expose()` are declared **directly in the part body**, not in a nested callback; names are unique within a part.
- A connector's source must resolve to **exactly one** face, edge or vertex, or be a plane; a raw point is refused inside a part. `resolve_selection` the expression at the part's scope and confirm `count` is 1 before writing it.
- A face connector sits at the face center with Z along the outward normal; a circular edge gives center plus axis; a straight edge gives midpoint plus tangent. `.offset(x, y, z)` and `.rotate(axis, deg)` move it in its own axes, in call order.
- Face frames point Z **out of the solid**, and a mate places the second Z against the first by default, so connectors on the touching faces of two parts put the parts on each other with no options.
- A sketch consumed by a feature must be `.reusable()` to still exist for `expose()`.

A standoff with its mating interface at the origin:

```fluid.js
import { part, param, sketch, circle, extrude, chamfer, connector, expose } from "fluidcad/core";
import { face } from "fluidcad/filters";

// Threaded standoff: hex bodies are a later refinement, the interface is
// what matters here. Foot on z = 0, axis on Z.
export const standoff = part("Standoff", () => {
  const height = param("Height", 12, "number", { min: 4, max: 60, step: 1 });
  const bodyDia = 6;
  const boreDia = 3.4; // ASSUMPTION: M3 clearance, no thread modeled

  sketch("xy", () => {
    circle([0, 0], bodyDia);
    circle([0, 0], boreDia);
  });
  const body = extrude(height);
  chamfer(0.5, body.endEdges());

  // Mating interface. startFaces() is the foot: Z points down, out of the
  // solid, so it lands face-to-face on an upward-facing plate connector.
  connector("foot", body.startFaces());
  connector("top", body.endFaces());
  // The bore, for a tangent mate or for another part to cut against.
  expose("bore", body.sideFaces(face().cylinder(boreDia)));
});
```

On the plate side, a connector per hole is the top-face frame moved along its own X and Y to the hole center, so the offsets read like the hole sketch coordinates:

```js
// plate.part.js, inside part("Base plate", () => { … })
connector("top", select(face().planar().onPlane("xy", plateT)));
connector("hole1", select(face().planar().onPlane("xy", plateT))).offset(-30, -17.5, 0);
connector("hole2", select(face().planar().onPlane("xy", plateT))).offset(30, -17.5, 0);
```

## 5. STEP parts via `load()`

A bought part with a STEP file becomes a part like any other:

1. Open (or create) the `.part.js` file the part will live in, so it is the current file, then `import_step` with the STEP's absolute path. The import is cached as `imports/<name>.brep` and a top-level `load('<name>');` statement is appended to the current file. The reply reports `solidCount` and `sourceUnits`.
2. Move that statement inside an exported `part()`, with the `load` import kept, and chain `.translate()` / `.rotate()` on the loaded object until its mating interface sits at the part origin (section 3). `load()` needs no unit: the cache is in mm and is scaled into the file's unit. `load("name", { unit: 'in' })` is an assertion for assets with untrustworthy metadata only.
3. Declare connectors from its geometry with filters restricted to it: `connector("mount", select(face().planar().onPlane("xy", 0).from(rail)))`, after `resolve_selection` confirms exactly one match. Imported solids often have many small faces; add `.cylinder(d)`, `.circle(d)` or `.above()` / `.below()` predicates until the count is 1.
4. Verify the part alone (section 6) before inserting it.

## 6. Build order

1. **Every part first, each verified alone.** Open its file, build it under the core skill's loop, `measure` the interface dimensions (hole pitch, bore diameter, the height a connector sits at), `resolve_selection` each connector's source expression and confirm one match. A part with `objectErrors` is not inserted.
2. **Create the assembly file** with one exported `assembly()` and the imports of the parts it uses. A bare `assembly()` that nothing exports renders blank.
3. **Insert every instance with a rough starting pose.** `insert(def)` or `insert(def, { Label: value })`, chained `.translate()` and `.name()`. Put each instance near where it will end up and not overlapping another; mates move it from there. Screenshot: every instance should be visible and identifiable.
4. **Ground exactly one instance per mechanism** with `.grounded()`. Everything else is solved against it.
5. **Mate one at a time, screenshot after each.** Write one `mate()`, check `render.state`, take a `screenshot` (with `focus` on the two instances when the scene is busy). Only when the pair sits right, write the next. Three mates written blind are three unknowns.
6. **Replicate, then verify the replicas.** `replicate(seed, targets, rows)` after the seed's mates are right; only mates written before the statement replicate.
7. **Close out** with the verification in section 8 and the core skill's report.

## 7. `insert()`, `mate()`, `replicate()`

- **`insert()`** returns an `Instance` (part) or `Occurrence` (sub-assembly). Chain `.translate(x, y, z)`, `.rotate(axis, deg)`, `.grounded()`, `.name("…")` in any order. The first insert of a variant builds it; repeats with equal overrides share the build.
- **`mate(type, a, b)`**: `fastened`, `revolute` (rotation about Z), `slider` (travel along Z), `cylindrical`, `planar` on connectors; `tangent` on exposures (`instance.features.name`). The two kinds are not interchangeable. The **first side drives**: options are read in its frame, and the second connector is placed face-to-face on it (origins coincide, second Z against the first).
- Options: `.flip()` when the parts should stack the other way; `.rotate(deg)` to spin the second frame about the shared Z; `.offset(x, y, z)` in the driver's frame (fastened and revolute any axis; slider, cylindrical and planar Z only); `.limits(min, max)` on revolute (degrees) and slider (project units); `.noPropagate()` on tangent.
- **`replicate(seed, targets, rows)`** copies a mated instance onto new targets: `targets` are the seed's outer mate sides that vary (connectors on other bodies), `rows` one array per replica. Replicas are never grounded, start at the seed's pose, and are named `<seed> (2)`, `(3)`. It is "copy with mates", not a geometric pattern; `repeat()` and `copy()` stay inside parts.
- **Sub-assemblies**: an `assembly()` definition can be inserted; its callback's return value is `occurrence.parts` for deep references (`swing.parts.arm.connectors.pivot`). `.grounded()` inside a body anchors within that body's frame; the parent decides whether the occurrence is grounded. Assembly connectors (`connector("name", [x, y, z])`) are root-scope only: declare them in the file that inserts the sub-assembly.

A motor-mount plate with four standoffs, one mate and one replicate:

```js
import { assembly, insert, mate, replicate } from "fluidcad/core";
import { plate } from "./plate.part.js";
import { standoff } from "./standoff.part.js";

export const motorMount = assembly("motor-mount", () => {
  const base = insert(plate).grounded();

  // Seed: one standoff on the first hole. The starting pose is the pose the
  // mate will produce, so measure and export agree with the viewport.
  const first = insert(standoff, { Height: 10 }).translate(-30, -17.5, 10).name("Standoff 1");
  mate("fastened", base.connectors.hole1, first.connectors.foot);

  // Three more, one per remaining hole.
  replicate(first, [base.connectors.hole1], [
    [base.connectors.hole2],
    [base.connectors.hole3],
    [base.connectors.hole4],
  ]);
});
```

## 8. Verifying an assembly

Two facts shape every check:

- **Screenshots show the mated layout.** Mates are solved live in the viewer, and `screenshot` renders what the viewport shows.
- **`measure`, `resolve_selection` and `export` use statement poses.** An entity given with its `instanceId` is measured where the instance's `insert().translate()/.rotate()` puts it; mate-solved or dragged poses are not applied. Instances of one part share a `shapeId`; the `instanceId` (from `get_scene_summary`) is what tells them apart.

So:

- **Verify part dimensions in the part file**, not through the assembly.
- **Validate the prototypes.** `validate` in the assembly file checks each inserted part's prototype once and lists the `instanceIds` that show it, so one finding covers every instance of that part. Fix a finding in the part file, then re-check the assembly. Scope with `instanceId` when only one part is in question.
- **Verify a mate visually** (a screenshot after each), and **numerically only when the statement pose equals the mated pose**: give each instance a `.translate()` / `.rotate()` that is the pose the mate produces, as in the example. Then `measure` between two faces on different instances (each with its `instanceId`) reports the assembled distance, and `resolve_selection` with `{ instanceId }` scope finds faces on that instance alone. When the pose is unknown, drag the instance in the viewport: the pose is written back onto the statement, and the next `measure` reads it.
- **Check the interface fits**: `measure` a standoff's bore face against the plate's hole face (both with instance ids) for concentricity; the `foot` face against the plate top face for a zero gap.
- **Count instances** with `get_scene_summary`: one entry per inserted instance and replica, named as expected.
- **Interference.** `interfere` in the assembly file compares every instance's bodies pairwise and reports the shared volume: a pair from two instances is a `clash`, a pair inside one instance (a multi-solid part) is `intraPart` and never fails, and anything below `tolerance` (1 mm³ by default, so touching faces pass) is ignored. Read `ok` together with `inconclusive`: one instance, or every body in one instance, is inconclusive and not a pass. It runs at statement poses like `measure`, so either give each instance the pose the mate produces (above) or pass `poses` from `get_scene_summary` after a viewport drag wrote the solved pose back. Narrow with `instanceIds`: one id tests that instance against everything, two test that pair. A `failed` pair is neither cleared nor a clash; say so.

Everything else follows the core skill: `render.state`, `objectErrors` (a failing part feature fails inside its instance), the report template, and the "never claim" list.

## 9. Export

`export` with `assembly: true` (an open `*.assembly.js` file) writes the whole assembly: STEP keeps the tree (shared part prototypes, one component per instance, sub-assemblies nested, names carried); STL flattens every placed part into one mesh, scaled to mm by default. The result's `posesSource` is `"statement"`: parts sit where the source places them, because the server never sees the viewer's solved mates. Tell the user, and point them at the viewer's Export for the mated layout. Pass `saveAsPath`; never round-trip the bytes through the conversation.

## Traps specific to assemblies

- **Overrides in the wrong unit.** `insert(def, { Length: 10 })` reads 10 in the part file's unit, even in a project with a different unit. Convert by hand once, comment it.
- **`unit()` in an assembly file.** Refused with `unit-statement`. Units belong to parts.
- **Two connectors on non-touching faces.** Face-to-face placement puts the second part inside the first. Put the connector on the face that touches, or `.flip()`.
- **A connector source matching two faces.** The statement fails; `resolve_selection` with the part as scope before writing it, and narrow to one.
- **Nothing grounded, or two things grounded.** Ground exactly one instance per mechanism; a second ground pins a part the mates were supposed to move.
- **Replicating before the mates.** Only mates written before `replicate()` are copied; a mate added afterwards applies to the seed only.
- **Measuring a mated distance from statement poses.** The number is the starting pose, not the solved one; see section 8. `interfere` reads the same poses: a clash it reports between two instances that the mates pull apart is a starting-pose overlap, and a clear result at starting poses says nothing about the mated layout.
- **`.rotate()` after `.translate()` on an instance.** `rotate(axis, deg)` turns the whole pose about the world axis, position included: `insert(p).translate(10, 0, 0).rotate("z", 90)` lands at `(0, 10, 0)`, not at `(10, 0, 0)` turned in place. Write `.rotate()` first, then `.translate()` (evidence: `lib/features/pose-handle.ts`, and an `interfere` test that expected the in-place turn).
- **Reading a part file's parameter from outside its body.** The body runs later, per variant; `param()` inside, values from the callback only.

## Quick reference: the assembly loop

1. Decide the split (section 1); state each part's origin convention (section 3).
2. Build and verify each part alone; `resolve_selection` every connector source to exactly one match.
3. Create the assembly file; insert every instance with a starting pose near its final one; screenshot.
4. Ground one instance.
5. One `mate()` per write, screenshot after each; `replicate()` once the seed is right.
6. Verify: `validate` for the prototypes; screenshots for the mated layout; `measure` plus `instanceId` where the statement pose is the mated pose; `interfere` once every instance sits at its mated pose; instance count from `get_scene_summary`.
7. Report per the core skill; quote the `interfere` result (clashes, or inconclusive with the reason) rather than claiming clearance from a screenshot.

---
id: api/connector
title: "connector(name, source, options?) / connector(name, [x, y, z])"
summary: "Declares a named mate frame. Inside part() it is attached to real geometry (a face, edge, vertex, anchored vertex or plane) and appears on every instance as instance.connectors.name; at the top level of an assembly file it is a free frame at a world point. Chain .offset(x, y, z) and .rotate(axis, deg) to move it in its own axes. copy() patterns it into read-only copies addressed bolt.instance(k)."
tags: [api, part, assembly, mate]
symbols: [connector]
seeAlso: [api/mate, api/part, api/insert, api/select, api/copy, api/replicate, concepts/assemblies]
---

# connector

Imported from `fluidcad/core`.

```ts
connector(name: string, source: SceneObject, options?: { xDirection?: AxisLike }): Connector   // inside part()
connector(name: string, position: [x, y, z]): Connector                                        // assembly top level
```

A connector is a coordinate frame — origin, X direction, Z normal — that
`mate()` joins to another connector. Part connectors are the part's mating
interface; every instance carries the same set, reached as
`instance.connectors.<name>`.

Where the frame comes from:

| source | origin | Z |
|--------|--------|---|
| planar face — `select(face().onPlane('xy', 10))` | face centre | outward normal |
| circular edge — `select(edge().circle(8))` | circle centre | circle axis |
| straight edge — `select(edge().line())` | edge midpoint | edge tangent |
| vertex | the point | world Z |
| anchored vertex — `e.endFaces().center()`, `sel.start()` | the anchor | the face / edge direction |
| plane — `plane('-xy')` | plane origin | plane normal |

The source must resolve to exactly one face, edge or vertex; a raw point is
refused inside a part (frames must re-derive from geometry). Chain
`.offset(x, y?, z?)` (translate along the frame's own axes) and
`.rotate('x' | 'y' | 'z', degrees)` (turn about its own axis) in call order.

Rules: declare connectors **directly in the part body** (not in a nested
callback); names are unique within a part. Face frames point Z out of the
solid, and a mate aligns two Zs against each other by default — so
connectors on the touching faces of two parts mate face-to-face.

The assembly-level form, `connector('name', [x, y, z])` at the top level of
a `*.assembly.js` file, is a free frame in the assembly's space with world
axes at the point; it is a mate side in its own right (root scope only).

## Example

```fluid.js
import { part, sketch, circle, extrude, chamfer, select, connector, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";
import { face } from "fluidcad/filters";

const pin = part("Pivot pin", () => {
  sketch("xy", () => {
    const c = circle([0, 0], 8);
    coincident(c.center(), origin());
    diameter(c, 8);
  });
  const shaft = extrude(-18);
  sketch("xy", () => {
    const c = circle([0, 0], 12);
    coincident(c.center(), origin());
    diameter(c, 12);
  });
  extrude(3);
  chamfer(1, shaft.endEdges());

  // Under the head: seats on whatever the pin goes through.
  connector("head", select(face().planar().onPlane("xy", 0)));
  // The tip face, Z pointing out of the pin.
  connector("tip", shaft.endFaces());
});
```

A frame moved to a hole on a face, then an assembly connector:

```js
// plate.part.js — the top-face frame moved along its own X / Y to a hole
connector("hole", select(face().planar().onPlane("xy", 10))).offset(-30, -17.5, 0);

// mechanism.assembly.js — a free frame, turned to face down
const mount = connector("mount", [0, 0, 40]).rotate("x", 180);
mate("fastened", mount, base.connectors.top);
```

## Copies: `instance(k)`

A connector is patterned with [[api/copy]], never with `repeat()`
(`repeat()` refuses connectors). The copy statement goes directly in the
same part body — or at the assembly's top level for an assembly connector —
and makes one read-only copy per pattern slot:

```js
copy("circular", "z", { count: 6, angle: 360 }, bolt);                   // bolt.instance(1) … bolt.instance(5)
copy("linear", ["x", "y"], { count: [2, 2], offset: [60, 35] }, hole);   // hole.instance(1) … hole.instance(3)
copy(holes, bolt);                                                        // follow a repeat: bolt.instance(k) on holes.instance(k)
copy("linear", "x", { count: 4, offset: 50 }, bay);                       // assembly connector: bay.instance(1) … bay.instance(3)
```

`bolt.instance(k)` — "copy k of `bolt`" — is the copy at slot `k`:

| where | address |
|-------|---------|
| the part file | `bolt.instance(3)` |
| an assembly | `f.connectors.bolt.instance(3)` |
| through a sub-assembly | `occ.parts.flange.connectors.bolt.instance(3)` |
| an assembly connector | `bay.instance(2)` |

A copy is a connector everywhere a connector goes: a `mate()` side, a
`replicate()` target or row cell, a copy axis. Slots are numbered like
`repeat().instance(k)`:

- **linear**: grid cells linearized with the first axis varying slowest;
  the original keeps its own cell — 0, or the centre cell when `centered`.
  A 2 × 2 grid from the original at slot 0: slot 1 is the next cell along
  the second axis, slot 2 the next along the first.
- **circular**: rotation steps, the original at 0.
- **follow form** `copy(holes, bolt)`: the repeat's own slots (a slot the
  repeat skips has no copy), so `bolt.instance(k)` sits on
  `holes.instance(k)`.

`bolt.instance(<original slot>)` is `bolt` itself. Dialog chips and error
messages label a copy with its source spelling, `bolt.instance(3)`; the
assembly's Connectors rail lists a family under its seed as `instance(1)`,
`instance(2)`, ….

**Copies are read-only.** A copy has no statement of its own:
`.rotate()` / `.offset()` on one throws (`bolt.instance(2) is a copy —
rotate bolt itself and its copies follow`). Move the seed and every copy
follows; change the pattern by editing the `copy()` statement. In the mate
dialog, the pen on a copy's chip edits the seed and says so.

**A copy is the seed's frame moved rigidly** by its slot's transform. It is
not re-derived from the geometry at its new place, so it does not land on a
hole unless the pattern puts it there. To keep copies on patterned
geometry, follow the geometry's repeat — `copy(holes, bolt)` — or give the
copy the same pattern the geometry has.

**Grid numbering is linearized.** Changing a later axis's count, or the
count of a `centered` pattern, renumbers the slots: a mate on
`hole.instance(2)` of a 2 × 2 grid moves to a different cell when the grid
becomes 2 × 3. The mated part visibly jumps, so the change is not silent.

Errors, thrown by `instance()` at the statement that calls it (a `mate()` or
`replicate()` line in an assembly):

- `bolt.instance(4) was skipped by the copy at flange.part.js:21`
  (following a repeat: `… by the repeat at flange.part.js:12 that the copy
  at flange.part.js:14 follows`);
- `bolt.instance(7) is out of range — the copy at flange.part.js:14 makes
  instances 0–5`;
- `bolt has no copies — copy it with copy(…) in its part`.

## A connector as a copy axis

`copy()` also takes a connector as its axis: the connector's Z axis through
its origin. A copy works too (`bolt.instance(2)`). At an assembly's top
level the axis is a world axis or an assembly connector — never an
inserted instance's connector, whose pose belongs to the solver.

```js
// three lugs around the pivot connector's Z axis
copy("circular", pivot, { count: 3, angle: 360 }, lug);
```

```fluid.js
import { part, sketch, circle, extrude, cut, repeat, connector, copy, origin } from "fluidcad/core";
import { coincident, diameter, fix } from "fluidcad/constraints";

// A Ø120 flange with six Ø10 bolt holes; one connector per hole.
const flange = part("Flange", () => {
  sketch("xy", () => {
    const rim = circle([0, 0], 120);
    coincident(rim.center(), origin());
    diameter(rim, 120);
  });
  const disc = extrude(12);
  sketch(disc.endFaces(), () => {
    const c = circle([45, 0], 10);
    diameter(c, 10);
    fix(c.center(), [45, 0]);
  });
  const hole = cut();
  const holes = repeat("circular", "z", { count: 6, angle: 360 }, hole);

  // The first hole's rim: origin on the hole axis, Z up out of the face.
  const bolt = connector("bolt", hole.startEdges());
  // bolt.instance(1) … bolt.instance(5), one on each repeated hole.
  copy(holes, bolt);
});
```

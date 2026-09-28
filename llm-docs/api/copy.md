---
id: api/copy
title: "copy(kind, axis, options, ...targets) / copy(pattern, ...connectors)"
summary: "Duplicates a finished shape at multiple positions — each copy independent of the original — and copies connectors (mate frames) into read-only families addressed bolt.instance(k): linear, circular, or following a linear/circular repeat() with copy(holes, bolt). Use repeat() when the modeling feature itself should be re-applied."
tags: [api, transform, pattern, connector]
symbols: [copy]
seeAlso: [api/repeat, api/connector, api/translate, api/mirror, api/replicate, concepts/coordinate-system]
---

# copy

Imported from `fluidcad/core`.

```ts
// Linear
copy("linear", axis: AxisLike | Connector, options, ...targets)
copy("linear", axes: (AxisLike | Connector)[], options, ...targets)

// Circular
copy("circular", axis: AxisLike | Connector, options, ...targets)   // 3D
copy("circular", center: Point2D, options, ...objects)              // inside a sketch

// Follow a repeat — connectors only, 3D, inside a part
copy(pattern: Repeat, ...connectors)
```

Inside a sketch, the linear axis is the sketch's own `xAxis()` /
`yAxis()` datum or a sketched line wrapped as `axis(l)`; a bare `"x"`
is the WORLD axis even there (see [[concepts/coordinate-system]]).

## Linear options (`LinearCopyOptions` / `LinearRepeatOptions`)

**Required:** `count` plus exactly one of `offset` or `length`.

- `count: number | number[]` — instances per axis (including original).
- `offset: number | number[]` — spacing between instances. Mutually
  exclusive with `length`.
- `length: number | number[]` — total span; instances are evenly
  distributed. Mutually exclusive with `offset`.
- `centered: boolean` — center the pattern around the original.
- `skip: number[][]` — index tuples to skip (per-axis).

## Circular options (`CircularCopyOptions` / `CircularRepeatOptions`)

**Required:** `count` plus exactly one of `offset` or `angle`.

- `count: number` — instances (including original).
- `angle: number` — sweep in degrees; the step is `angle / count`.
  Mutually exclusive with `offset`.
- `offset: number` — angular spacing in degrees between instances.
  Mutually exclusive with `angle`.
- `centered: boolean` — center the pattern around the original.
- `skip: number[]` — indices to skip.

**The step is always `angle / count`**, a partial arc included:
`{ count: 4, angle: 90 }` puts instances at 0°, 22.5°, 45° and 67.5°, one
step short of 90°. A full turn (`angle: 360`) spaces them evenly with none
on top of another. `repeat()` differs on partial arcs — it steps
`angle / (count - 1)`, so its last instance lands on `angle` (0°, 30°, 60°,
90°); see [[api/repeat]]. To put connectors on a repeat's partial arc,
follow the repeat (below) instead of copying around the same axis.

`copy()` snapshots the finished shape — copies don't share the
modeling history of the source. For feature-aware patterns (where each
position re-runs the original op) use [[api/repeat]].

With no targets, a 3D `copy()` copies every solid built so far (never a
connector). The value it returns has `instance(k)` only inside a sketch (a
2D copy's slots); a 3D copy's result has no `instance()` — a connector's
copies are addressed on the connector, `bolt.instance(k)`.

## Example

```fluid.js
import { circle, copy, extrude, origin, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
  const c = circle([0, 0], 8);
  coincident(c.center(), origin());
  diameter(c, 8);
});
const pin = extrude(20).new();
copy("linear", "x", { count: 4, offset: 25 }, pin);
```

## Connectors

Inside a part, a [[api/connector]] among the targets is copied as a
frame: each placed slot gets a read-only copy, `bolt.instance(k)` —
"copy k of `bolt`" — mated from an assembly as
`f.connectors.bolt.instance(k)`. Solids and connectors can be mixed in one
statement. `repeat()` refuses connectors; `copy()` is how a connector is
patterned.

```js
copy("circular", "z", { count: 6, angle: 360 }, bolt);                   // bolt.instance(1) … bolt.instance(5)
copy("linear", ["x", "y"], { count: [2, 2], offset: [60, 35] }, hole);   // hole.instance(1) … hole.instance(3)
copy("circular", "z", { count: 6, angle: 360 }, boss, bolt);             // the boss and its connector together
```

Slots number like `repeat().instance(k)` (linear: the first axis varies
slowest, the original in its own cell; circular: steps from 0). Each copy
is the connector's frame moved rigidly by its slot's transform — it does
not re-attach to geometry at its new place. See [[api/connector]] for the
numbering, the read-only rules and the `instance()` errors.

Rules, each refused on the copy statement's own row (`getError()`, the
timeline, `objectErrors`) — a refused statement copies nothing, solids
included:

- targets are explicit — `copy()` with no targets never copies connectors;
- one copy statement per connector (`copy(): bolt is already copied by the
  copy at flange.part.js:14 — one copy statement per connector (a grid is
  one two-axis linear copy)`);
- a copy is not copied again (`copy(): bolt.instance(1) is itself a copy
  and isn't copied again — copy bolt instead …`), and a connector is listed
  once;
- directly in the connector's own part body — not in another part, not at
  the file's top level, not in a nested callback, not inside a sketch;
- a count of at least 1 on every axis;
- circular `centered` is refused for connectors (`copy(): a circular copy
  of a connector can't be centered yet — drop centered; the pattern then
  starts at the connector`).

### A connector as the axis

A connector (or a copy, `bolt.instance(2)`) is accepted as the axis: its Z
axis through its origin.

```js
copy("circular", pivot, { count: 3, angle: 360 }, lug);   // around pivot's Z axis
```

### Follow a repeat: `copy(pattern, ...connectors)`

`copy(holes, bolt)` lays a copy of `bolt` on every instance of the
`repeat()` `holes`: each copy is `bolt` moved the way the repeat moved that
instance, so `bolt.instance(k)` sits on `holes.instance(k)` — the repeat's
own slots, its skips, and a partial arc spaced the repeat's way. Edit the
repeat (count, spacing, axis, skip) and the copies follow. This is the form
for a connector on a patterned hole.

```fluid.js
import { part, sketch, circle, extrude, cut, repeat, connector, copy, origin } from "fluidcad/core";
import { coincident, diameter, fix } from "fluidcad/constraints";

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
  // Four holes over a 90° arc: 0°, 30°, 60°, 90°.
  const holes = repeat("circular", "z", { count: 4, angle: 90 }, hole);
  const bolt = connector("bolt", hole.startEdges());
  copy(holes, bolt);   // bolt.instance(1) … bolt.instance(3), one per repeated hole
});
```

Rules and refusals (on the statement's row):

| case | message |
|------|---------|
| a mirror repeat | `copy(): copy(pattern, …) follows a linear or circular repeat() — a mirror repeat reflects its instance, and a copied connector is never reflected` |
| a rotate or matrix repeat | `copy(): copy(pattern, …) follows a linear or circular repeat() — not a rotate or matrix repeat; turn a connector with copy('circular', axis, options, …)` |
| not a repeat | `copy(): copy(pattern, …) follows a repeat() — got cut(); pass the repeat() itself, e.g. copy(holes, bolt)` |
| no connectors | `copy(): copy(pattern, …) needs the connectors to copy — e.g. copy(holes, bolt)` |
| a solid among the targets | `copy(): copy(pattern, …) copies connectors only — got extrude(); copy solids with copy('linear' \| 'circular', axis, options, …)` |
| the repeat is in another part or at the file's top level | `copy(): the repeat belongs to part "donor" — a connector follows a repeat in its own part's body` |
| the repeat itself is refused | `copy(): the repeat this copy follows is refused, so it has no instances to follow — fix that repeat first` |
| a centered circular repeat | `copy(): a connector can't follow a centered circular repeat yet — drop centered on the repeat; its pattern then starts at the original` |
| a repeat with no instances | `copy(): the repeat numbers no instances — a connector copy needs a count of at least 1` |
| at an assembly's top level | `copy(): copy(pattern, …) follows a repeat() inside a part's body — at an assembly's top level copy a connector with copy('linear' \| 'circular', axis, options, …)` |

The connector rules above apply too (one statement per connector, no copy
of a copy, the connector's own part body, not in a sketch). A slot the
repeat skipped throws from `instance()`: `bolt.instance(2) was skipped by
the repeat at flange.part.js:12 that the copy at flange.part.js:14
follows`.

### At an assembly's top level

In an `*.assembly.js` file, `copy()` copies **assembly connectors only**:

```js
const bay = connector("bay", [0, 0, 20]);
copy("linear", "x", { count: 4, offset: 50 }, bay);   // bay.instance(1) … bay.instance(3)
mate("slider", bay.instance(2), card.connectors.edge);
```

Root scope only (not inside an `assembly()` body), explicit connector
targets (no solids, no inserted instance's `f.connectors.x`), and the axis
is a world axis or an assembly connector — never a part connector. The
follow form is part-only. `repeat()` stays inside parts.

See [[api/repeat]] for the feature-replay alternative and
[[api/translate]] for the single-instance case.

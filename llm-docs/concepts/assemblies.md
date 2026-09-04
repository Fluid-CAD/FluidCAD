---
id: concepts/assemblies
title: "Parts and assemblies — files, inserting, grounding, mating"
summary: "A .part.js file exports a part() with param() values, connector() mate frames and expose()d geometry; a .assembly.js file exports an assembly() whose body insert()s parts, .grounded()s one and mate()s the rest. Mates are solved live in the viewport. Units are the project's; parts are scaled in; overrides are in the part's unit."
tags: [concept, assembly, part]
seeAlso: [api/part, api/param, api/connector, api/expose, api/assembly, api/insert, api/mate, api/replicate, concepts/units]
---

# Parts and assemblies

## File kinds

| suffix | scene | contents |
|--------|-------|----------|
| `.part.js` | part | modelling statements; optionally `export const x = part('X', () => { … })` |
| `.assembly.js` | assembly | `export const x = assembly('x', () => { insert(); mate(); … })` |
| `.fluid.js` | part | legacy suffix, same as `.part.js` |

A part file renders every part it declares. Only an **exported** `part()`
can be inserted elsewhere. A new assembly file is scaffolded as one exported
`assembly()` definition; the UI writes inserts and mates inside its callback.

## A part's interface

| statement | in | out |
|-----------|----|-----|
| `param('Label', default, type?, opts?)` | `insert(def, { Label: value })` | the Parameters panel / Insert wizard controls |
| `connector('name', geometry)` | — | `instance.connectors.name` for `mate()` |
| `expose('name', sceneObject)` | — | `def.features.name` (another part), `instance.features.name` (tangent mate) |

Connectors and exposures must be declared directly in the part body. A
connector is a frame (origin, X, Z) derived from a face (centre + outward
normal), a circular edge (centre + axis), a straight edge (midpoint +
tangent), an anchored vertex or a plane; `.offset()` and `.rotate()` move it
in its own axes.

## Workflow

1. `insert(def)` each part; chain `.translate()` / `.rotate()` for a starting
   pose and `.name()` for a label.
2. `.grounded()` exactly one instance per mechanism — the frame everything
   else is solved against.
3. `mate(type, a, b)` the rest. The first side drives; the second connector
   is placed face-to-face on it by default (`.flip()` for the other way),
   spun with `.rotate(deg)`, shifted with `.offset(x, y, z)`, bounded with
   `.limits(min, max)`.
4. `replicate(seed, targets, rows)` to copy a mated part onto new targets.

Mates are solved in the viewer, live. The server's render places parts
where the source puts them; the mated layout is what the viewport shows and
what the viewer's Export writes.

## Sub-assemblies and connectors

`assembly()` definitions nest: `insert(sub)` returns an occurrence whose
`.parts` is the body's return value, so deep references
(`occ.parts.arm.connectors.pivot`) bind to that occurrence. `.grounded()`
inside a body anchors within that body's frame; the parent grounds the
occurrence to pin it for real.

`connector('name', [x, y, z])` at an assembly file's top level is a free
frame — a mate side that belongs to no part, root scope only.

## Units

An assembly never calls `unit()`. Its own lengths (translate, mate offsets
and limits) are in the **project unit**; inserted parts are built in their
file's unit and scaled into it, connectors included; `insert(def, { Length:
10 })` is read in the **part's** unit. See [[concepts/units]].

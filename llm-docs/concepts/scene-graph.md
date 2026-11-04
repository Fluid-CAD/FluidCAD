---
id: concepts/scene-graph
title: The scene graph and feature tree
summary: Each call to a feature (sketch, extrude, fillet, …) appends a SceneObject to an ordered feature tree. The tree drives history, rollback, and shape reuse across re-renders.
tags: [concept, architecture]
seeAlso: [concepts/last-selection, concepts/history-and-rollback, api/sketch, api/extrude, concepts/custom-features]
---

# The scene graph

A FluidCAD script is read top-to-bottom; each modeling call appends one
`SceneObject` to an ordered **feature tree**. The tree is the canonical
source for everything that happens later:

- Renders walk it in order, producing meshes and an `id` per object.
- Rollback shows the partial state at any point in the tree.
- Re-renders compare the new tree against the previous one and **reuse**
  unchanged OCC shapes (this is what makes parameter tweaks fast).

Containers (like `part(...)`) introduce a sub-tree: their children only
auto-fuse with each other, not with the outside world.

A custom feature's statement (`standoff(…)` from a `*.feature.js` module)
is one object in the tree like a built-in's; a re-render reuses it when its
id and values match ([[concepts/custom-features]]).

## Implicit consumption

Most features consume the **last** matching item (last sketch, last
selection, last operation). See [[concepts/last-selection]] for the full
rules. The feature tree records both the consumer and what it consumed —
so swapping a sketch's parameters in source code can be reused without
re-running everything downstream.

## Feature names are optional

Any feature statement may end in `.name('…')` (`extrude(10).name('Base')`),
and the FluidCAD UI writes one onto every statement it creates. Code written
by hand or through MCP may leave it out: an unnamed feature is labelled
`<Type> <n>` (`Extrude 1`, `Sketch 2`, …) at render time, numbered in file
order per type, and nothing requires the chain. Names are unique within a
file — a `.name()` that repeats another statement's name, or a `part()`'s
name, is refused when set from the UI.

## A variable names a body, not a snapshot

A modifying feature takes the solid it works on: `fillet(3, e.endEdges())`
removes the extrude's body and holds the filleted one. The variable `e`
still names that body wherever the features since left it — a later
`mirror("xz", e)`, `translate(v, e)`, `rotate("x", 90, e)`, `fuse(e, g)`,
`subtract(e, g)`, `common(e, g)`, `copy(…, e)` or `.scope(e)` reads it
filleted, moved, or fused into its neighbour, as it is at that point in
the tree. This is what makes inserting a feature in the middle of a
script safe (paused at a breakpoint, say): the statements after it keep
their references. Only a body nothing stands for any more fails: one
`remove()` took, or a cut consumed entirely. Sub-shape accessors are
different — `e.sideEdges()` names the edges as the extrude built them, so
a feature that reshaped those edges leaves the accessor empty.

## What the agent gets

`get_scene_summary` returns the feature tree projected to a JSON-safe
view: one entry per operation, with `kind` (`sketch`, `extrude`, …),
`params` (operation-specific), `sourceLocation` (file + line), and
`shapeIds`. `list_shapes` returns the flat shape list with the owning
operation's id. Pair them when answering "what does shape X come from?"

In an assembly file the summary also lists `instances`, one per inserted
instance (sub-assemblies' included): `instanceId`, `name`, the part it
inserts (`partId`, `partName`), `owner` (the sub-assembly occurrence path,
`""` at the root), `grounded`, `shapeIds` (the rendered solids it shows,
the same for every instance of a part), `pose` and `sourceLocation`.
`instancePoses` says what the poses are: `{ frame: "world", source:
"statement" }`, where the `insert()` statements put each instance, not
where the viewer's mate solve draws it. `occurrences` lists inserted
sub-assemblies (a generated assembly's with `generated: { definition,
values }`).

`mates` lists every mate, sub-assemblies' and generators' included, in
statement order: `mateId`, `name` (when authored), `type`, and the two
sides `a` (the driver) and `b`. A side is a part connector `{ kind:
"connector", instanceId, instance, connector, connectorId }` (`instance`
the instance's name, `connector` what code writes after `.connectors.`, a
copy as `bolt.instance(2)`, `connectorId` its row in `objects`), an
assembly connector `{ kind: "assembly-connector", connector, connectorId
}`, or a tangent mate's exposure `{ kind: "exposure", instanceId,
instance, exposure }`. `options` holds only what differs from the default:
`flip`, `rotate` (degrees), `offset` (document unit), `limits` (`[min,
max]`: degrees on a revolute, the document unit on a slider), `propagate:
false`. `relations` (when there are any) lists `relationId`, `name`,
`type`, `ratio`, `reverse` and the two mates as `mateA` / `mateB` (`{
mateId, name }`). Every mate and relation carries its `owner` (`""` at the
root, else the occurrence path) with `ownerName`, `sourceLocation`, and
`engineOwned: true` when a generator's layout made it (read-only; its
location is the insert that makes it; an instance a generator made is
marked the same way).

`joints: { source: "statement", solvedIn: "viewer" }` says what those are:
the records as authored. The assembly solver runs only in the viewer and
the server never receives its result, so the summary reports no solve
status, misclosure or joint value — whether a joint closes and how far it
moves shows on screen. A part file's summary has none of these keys.

---
id: concepts/scene-graph
title: The scene graph and feature tree
summary: Each call to a feature (sketch, extrude, fillet, …) appends a SceneObject to an ordered feature tree. The tree drives history, rollback, and shape reuse across re-renders.
tags: [concept, architecture]
seeAlso: [concepts/last-selection, concepts/history-and-rollback, api/sketch, api/extrude]
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

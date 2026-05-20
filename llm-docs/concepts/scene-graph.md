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

## What the agent gets

`get_scene_summary` returns the feature tree projected to a JSON-safe
view: one entry per operation, with `kind` (`sketch`, `extrude`, …),
`params` (operation-specific), `sourceLocation` (file + line), and
`shapeIds`. `list_shapes` returns the flat shape list with the owning
operation's id. Pair them when answering "what does shape X come from?"

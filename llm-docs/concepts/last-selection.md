---
id: concepts/last-selection
title: Implicit "last-X" context (last sketch, last selection)
summary: Many operations have a default target. extrude consumes the last sketch; fillet consumes the last selection. Pass arguments explicitly to override.
tags: [concept, architecture]
seeAlso: [concepts/scene-graph, api/sketch, api/extrude, api/fillet]
---

# The "last-X" context

FluidCAD threads several implicit contexts through a script so common
patterns stay terse:

| Op | Default target |
|----|----------------|
| `extrude` / `cut` / `revolve` / `sweep` | last sketch |
| `loft` | all current sketches as profiles (or pass them explicitly) |
| `fillet` / `chamfer` / `shell` / `color` / `draft` | last selection (`select(...)` or a direct accessor immediately before) |
| `repeat` (no last arg) | last created operation |
| `copy` (no last arg) | last object |
| `subtract` / `fuse` / `common` (with args) | the given objects |

## Patterns

```fluid.js
// Last-sketch consumption
sketch("xy", () => rect(100, 60).centered());
extrude(30);                              // ← consumes the rect

// Last-selection consumption via direct accessor
const e = extrude(30);
fillet(5, e.endEdges());                  // explicit form (preferred)

// Last-selection consumption via select()
select(edge().verticalTo("xy"));
fillet(3);                                // picks up the selection
```

## When the implicit form bites

- A sketch is consumed exactly once. To use it twice, mark it `.reusable()`.
- A selection is good for the very next op. If you do anything between
  `select(...)` and the consumer, capture the selection in a variable.
- For multi-step pipelines, explicit arguments are clearer than relying
  on the implicit chain.

When the agent is unsure which sketch will be consumed, use
`get_scene_summary` to see the current tree and which operation pulled
which inputs.

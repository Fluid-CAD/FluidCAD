---
id: concepts/history-and-rollback
title: History and rollback
summary: The feature tree is also a timeline. Rollback shows the scene at any earlier point; breakpoints stop evaluation there for inspection.
tags: [concept, debug]
seeAlso: [concepts/scene-graph]
---

# History and rollback

The ordered feature tree is also a timeline. You can:

- **Rollback** to any operation index: the renderer stops there and emits
  the partial scene. The UI shows the same view as if the script ended at
  that point.
- **Set a breakpoint** at a source line: evaluation halts there, the
  renderer marks `breakpointHit: true`, and downstream operations don't
  run. Useful for inspecting an intermediate state without changing the
  script.

The MCP `rollback_to(index)` and `add_breakpoint(file, line)` /
`clear_breakpoints()` tools drive both of these without editing source.

## What rollback does NOT touch

- The source file. Rollback is a render-time operation; the file on disk
  is unchanged.
- The previous cache. `SceneCompare` still reuses shapes from before the
  rollback when re-rendering forward.

## When to use rollback over editing the source

- Inspecting whether a specific feature is the cause of a problem.
- Capturing a screenshot of an intermediate step (e.g., the sketch before
  the extrude consumes it).
- Confirming the order of operations in the timeline matches what the
  agent expects.

After a rollback, re-issuing `recompute` or letting the file watcher fire
the next `live-update` resets to the full scene.

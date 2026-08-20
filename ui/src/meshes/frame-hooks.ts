// Per-frame callbacks that must run BEFORE the scene is drawn.
//
// Three's own `onBeforeRender` only fires for objects that are actually
// rendered, which makes it useless for work that decides what to render —
// a hook that has to un-hide a mesh can never run while the mesh is hidden.
// SceneContext drains this registry at the top of every `render()` instead.
//
// Kept next to screen-scale.ts, which already owns the renderer/camera
// plumbing screen-space work needs.

import type { Camera, WebGLRenderer } from 'three';

export type FrameHook = (renderer: WebGLRenderer, camera: Camera) => void;

const hooks = new Set<FrameHook>();

/** Register `hook`; the returned function unregisters it. */
export function addFrameHook(hook: FrameHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

export function runFrameHooks(renderer: WebGLRenderer, camera: Camera): void {
  // Snapshot: a hook that unregisters itself (a detached mesh cleaning up)
  // must not disturb the iteration it is doing so from.
  for (const hook of [...hooks]) {
    hook(renderer, camera);
  }
}

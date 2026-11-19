// Every CLI child the engine started, killed when the engine exits: an agent
// must never outlive the project it was working on.

import type { ChildProcess } from 'node:child_process';

const children = new Set<ChildProcess>();
let hooked = false;

export function trackChild(child: ChildProcess): void {
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', () => children.delete(child));
  if (!hooked) {
    hooked = true;
    // `exit` handlers run synchronously; kill() is synchronous. The engine's
    // SIGINT / SIGTERM handlers call process.exit(), which lands here too.
    process.on('exit', killAllChildren);
  }
}

export function killAllChildren(): void {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  children.clear();
}

export function trackedChildCount(): number {
  return children.size;
}

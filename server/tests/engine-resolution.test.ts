import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureEngineLink, ENGINE_LINK_MARKER } from '../src/host/engine-resolution.ts';

/**
 * The rule: link this server's package into the workspace *only* when the
 * workspace cannot resolve `fluidcad` itself. Both halves have burned us:
 *
 * - deciding "it can resolve" with `createRequire().resolve()` consulted
 *   CJS-only global folders (`~/node_modules`) that Vite and Node ESM ignore,
 *   so nothing was linked and models failed with "Cannot find module";
 * - answering the failure with anything *other* than a real on-disk path
 *   (a Vite plugin, Node loader hooks) left Vite's own `tryNodeResolve`
 *   unsatisfied or made it inline a second lib copy — breakpoints then
 *   surfaced as the compile error "FluidCAD breakpoint hit".
 */

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-engine-link-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** A minimal package that looks like the kernel to the resolver walk. */
function installEngineAt(root: string): void {
  const dist = path.join(root, 'node_modules', 'fluidcad', 'lib', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.js'), 'export const marker = true;\n');
}

const linkPath = () => path.join(workspace, 'node_modules', 'fluidcad');
const markerPath = () => path.join(workspace, 'node_modules', ENGINE_LINK_MARKER);

describe('ensureEngineLink', () => {
  it('links the running server\'s package when the workspace has no engine', () => {
    const result = ensureEngineLink(workspace);
    expect(result.state).toBe('linked');

    // The link is real and resolution now works the way every tool resolves:
    // the kernel's entry is reachable through the workspace's node_modules.
    expect(fs.lstatSync(linkPath()).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(linkPath(), 'lib', 'dist', 'index.js'))).toBe(true);
    // And it is labeled, so the shell never mistakes it for a real install.
    expect(fs.existsSync(markerPath())).toBe(true);
  });

  it('is idempotent, re-pointing an existing link at the running engine', () => {
    expect(ensureEngineLink(workspace).state).toBe('linked');
    // Once linked the workspace resolves — the second call must not churn.
    expect(ensureEngineLink(workspace).state).toBe('already-resolvable');
  });

  it('re-points a marked link left by another engine version', () => {
    // A stale managed link still *resolves*, so a naive resolvability check
    // would leave it standing — and the lib-identity check would then fail the
    // startup against the copy the link points at.
    const otherEngine = path.join(workspace, 'other-engine');
    fs.mkdirSync(path.join(otherEngine, 'lib', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(otherEngine, 'lib', 'dist', 'index.js'), 'export const old = true;\n');
    fs.mkdirSync(path.join(workspace, 'node_modules'));
    fs.symlinkSync(otherEngine, linkPath(), 'junction');
    fs.writeFileSync(markerPath(), 'managed\n');

    expect(ensureEngineLink(workspace).state).toBe('linked');
    expect(fs.realpathSync(linkPath())).not.toBe(fs.realpathSync(otherEngine));
    // Now it points at the running engine's own package.
    expect(fs.existsSync(path.join(linkPath(), 'server', 'dist'))).toBe(true);
  });

  it('replaces a dangling link left by a pruned engine', () => {
    fs.mkdirSync(path.join(workspace, 'node_modules'));
    fs.symlinkSync(path.join(workspace, 'gone'), linkPath(), 'junction');
    expect(ensureEngineLink(workspace).state).toBe('linked');
    expect(fs.existsSync(path.join(linkPath(), 'lib', 'dist', 'index.js'))).toBe(true);
  });

  it('stays out of the way when the workspace installs its own engine', () => {
    installEngineAt(workspace);
    expect(ensureEngineLink(workspace).state).toBe('already-resolvable');
    expect(fs.existsSync(markerPath())).toBe(false);
  });

  it('stays out of the way when an ancestor directory holds the engine', () => {
    const project = path.join(workspace, 'nested', 'project');
    fs.mkdirSync(project, { recursive: true });
    installEngineAt(workspace);
    expect(ensureEngineLink(project).state).toBe('already-resolvable');
    expect(fs.existsSync(path.join(project, 'node_modules'))).toBe(false);
  });

  it('refuses to replace a real directory, even a broken one', () => {
    // A `fluidcad` that is present but not a kernel — a half-finished install,
    // or this repo's extension sharing the name. Not ours to delete.
    fs.mkdirSync(linkPath(), { recursive: true });
    fs.writeFileSync(path.join(linkPath(), 'package.json'), '{"name":"fluidcad"}');
    const result = ensureEngineLink(workspace);
    expect(result.state).toBe('skipped');
    expect(fs.lstatSync(linkPath()).isDirectory()).toBe(true);
  });

  it('does nothing without a workspace (the hub path)', () => {
    expect(ensureEngineLink('').state).toBe('skipped');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { engineSelfLinks } from '../src/host/engine-resolution.ts';

/**
 * The rule: rewrite the bare `fluidcad` specifier to this server's own package
 * *only* when the workspace cannot resolve it itself. Getting the second half
 * wrong is what broke the desktop shell on macOS — `createRequire().resolve()`
 * answered "yes it can" because of a `fluidcad` in a CJS global folder
 * (`~/node_modules`), which Node's ESM resolver and Vite never look at, so the
 * model failed with *Cannot find module 'fluidcad'*.
 */

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-engine-resolution-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** A minimal package that looks like the kernel to the resolver. */
function installEngineAt(root: string): void {
  const dist = path.join(root, 'node_modules', 'fluidcad', 'lib', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.js'), 'export const marker = true;\n');
  fs.writeFileSync(
    path.join(root, 'node_modules', 'fluidcad', 'package.json'),
    JSON.stringify({ name: 'fluidcad', version: '0.0.0' }),
  );
}

describe('engineSelfLinks', () => {
  it('links the running server\'s own package when the workspace has no engine', () => {
    const links = engineSelfLinks(workspace);
    expect(links).not.toBeNull();

    const entry = links!.get('fluidcad');
    expect(entry).toBeDefined();
    // Absolute, and inside this checkout — the same copy the server imported.
    expect(path.isAbsolute(entry!)).toBe(true);
    expect(fs.existsSync(entry!)).toBe(true);
    expect(entry!.endsWith(path.join('lib', 'dist', 'index.js'))).toBe(true);

    // Subpaths come from the package's own `exports` map, not a hardcoded list.
    expect(links!.get('fluidcad/core')).toBeDefined();
    expect(links!.get('fluidcad/filters')).toBeDefined();
  });

  it('stays out of the way when the workspace installs its own engine', () => {
    installEngineAt(workspace);
    expect(engineSelfLinks(workspace)).toBeNull();
  });

  it('stays out of the way when an ancestor directory holds the engine', () => {
    const project = path.join(workspace, 'nested', 'project');
    fs.mkdirSync(project, { recursive: true });
    installEngineAt(workspace);
    expect(engineSelfLinks(project)).toBeNull();
  });

  it('ignores a `fluidcad` that is not the kernel', () => {
    // This repo's npm workspaces symlink `node_modules/fluidcad` to the VS Code
    // extension, which shares the package name and carries no `lib/dist`.
    const impostor = path.join(workspace, 'node_modules', 'fluidcad');
    fs.mkdirSync(impostor, { recursive: true });
    fs.writeFileSync(
      path.join(impostor, 'package.json'),
      JSON.stringify({ name: 'fluidcad', version: '0.0.0', main: 'extension.js' }),
    );
    expect(engineSelfLinks(workspace)).not.toBeNull();
  });

  it('does nothing without a workspace (the hub path)', () => {
    expect(engineSelfLinks('')).toBeNull();
  });
});

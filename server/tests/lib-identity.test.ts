import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findLibIdentityMismatch } from '../src/lib-identity.ts';

const serverLib = fs.realpathSync(path.resolve(import.meta.dirname, '../../lib/dist/index.js'));

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-lib-identity-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** A second kernel copy the workspace resolves on its own. */
function installOtherCopy(): string {
  const root = path.join(workspace, 'node_modules', 'fluidcad');
  fs.mkdirSync(path.join(root, 'lib', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fluidcad","main":"lib/dist/index.js"}\n');
  fs.writeFileSync(path.join(root, 'lib', 'dist', 'index.js'), 'export const other = true;\n');
  return fs.realpathSync(root);
}

describe('findLibIdentityMismatch', () => {
  it('is silent for a workspace with nothing installed', () => {
    expect(findLibIdentityMismatch(workspace)).toBeNull();
  });

  it('reports a different copy the workspace resolves on its own', () => {
    const other = installOtherCopy();
    expect(findLibIdentityMismatch(workspace)?.workspaceRoot).toBe(other);
  });

  it('compares the entry the host steers the import to, not what sits on disk', () => {
    // The copy on disk is never imported once the host answers `fluidcad`
    // itself (an ancestor's copy with the link refused, say), so it is no
    // mismatch — and a steered entry that *is* a different copy still is.
    const other = installOtherCopy();
    expect(findLibIdentityMismatch(workspace, serverLib)).toBeNull();
    expect(findLibIdentityMismatch(workspace, path.join(other, 'lib', 'dist', 'index.js'))?.workspaceRoot).toBe(other);
  });
});

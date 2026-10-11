import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_CONFIG_FILENAME, readProjectPin, writeProjectPin } from '../src/engine/project-pin';
import { readProjectConfig } from '../../server/src/project-config';

/**
 * The launcher's pin parser is frozen (one key, `engine`, a version string)
 * and must stay that way: it runs before any engine is chosen. What keeps a
 * package workspace and a project's package pins safe is that the launcher
 * reads `engine` only and keeps every other key when it writes — the
 * packages plan's `package` and `dependencies` included.
 */

const PACKAGE = {
  name: 'gears',
  version: '1.2.0',
  description: 'Spur gears and a gear-train feature',
  minEngine: '0.0.46',
};

const DEPENDENCIES = {
  '@acme/fasteners': { version: '2.0.1', integrity: 'sha256-' + 'A'.repeat(42) + 'E=' },
};

let workspace: string;

function readStored(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8'));
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-project-pin-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('writeProjectPin', () => {
  it('keeps package and dependencies when it changes the pin', () => {
    const before = {
      engine: '0.0.45',
      unit: 'in',
      materials: { pine: { name: 'Pine', density: 0.5 } },
      package: PACKAGE,
      dependencies: DEPENDENCIES,
    };
    fs.writeFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), JSON.stringify(before, null, 2) + '\n');

    writeProjectPin(workspace, '0.0.46');

    expect(readStored()).toEqual({ ...before, engine: '0.0.46' });
    // The engine reads both blocks back unchanged after the launcher's write.
    const config = readProjectConfig(workspace);
    expect(config.error).toBeUndefined();
    expect(config.engine).toBe('0.0.46');
    expect(config.package).toEqual(PACKAGE);
    expect(config.dependencies).toEqual(DEPENDENCIES);
  });

  it('keeps them when the file had no pin yet', () => {
    fs.writeFileSync(
      path.join(workspace, PROJECT_CONFIG_FILENAME),
      JSON.stringify({ package: PACKAGE, dependencies: DEPENDENCIES }),
    );

    writeProjectPin(workspace, '0.0.46');

    expect(readStored()).toEqual({ package: PACKAGE, dependencies: DEPENDENCIES, engine: '0.0.46' });
  });

  it('keeps blocks it cannot judge, even ones the engine would refuse', () => {
    const broken = { package: { name: 'not-scoped' }, dependencies: { '@acme/fasteners': '^2.0.0' } };
    fs.writeFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), JSON.stringify(broken));

    writeProjectPin(workspace, '0.0.46');

    expect(readStored()).toEqual({ ...broken, engine: '0.0.46' });
  });
});

describe('readProjectPin', () => {
  it('reads the pin beside package and dependencies', () => {
    fs.writeFileSync(
      path.join(workspace, PROJECT_CONFIG_FILENAME),
      JSON.stringify({ engine: '0.0.46', package: PACKAGE, dependencies: DEPENDENCIES }),
    );

    expect(readProjectPin(workspace)).toEqual({ engine: '0.0.46', source: 'fluidcad.json' });
  });
});

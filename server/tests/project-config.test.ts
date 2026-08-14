import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readProjectConfig,
  writeEnginePin,
  describeEnginePinMismatch,
  PROJECT_CONFIG_FILENAME,
} from '../src/project-config.ts';

let workspace: string;

function write(name: string, contents: string): void {
  fs.writeFileSync(path.join(workspace, name), contents);
}

function writeJson(name: string, value: unknown): void {
  write(name, JSON.stringify(value, null, 2) + '\n');
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-project-config-test-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('readProjectConfig', () => {
  it('reads the pin from fluidcad.json', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41' });

    const config = readProjectConfig(workspace);

    expect(config.engine).toBe('0.0.41');
    expect(config.source).toBe('fluidcad.json');
    expect(config.filePath).toBe(path.join(workspace, PROJECT_CONFIG_FILENAME));
    expect(config.error).toBeUndefined();
  });

  it('reads the pin from package.json when there is no fluidcad.json', () => {
    writeJson('package.json', { name: 'my-model', fluidcad: { engine: '0.0.38' } });

    const config = readProjectConfig(workspace);

    expect(config.engine).toBe('0.0.38');
    expect(config.source).toBe('package.json');
  });

  it('prefers fluidcad.json over package.json', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41' });
    writeJson('package.json', { fluidcad: { engine: '0.0.38' } });

    expect(readProjectConfig(workspace).engine).toBe('0.0.41');
  });

  it('falls through to package.json when fluidcad.json carries no engine key', () => {
    // Later phases add other fields to this file; a config that doesn't
    // happen to pin isn't malformed.
    writeJson(PROJECT_CONFIG_FILENAME, { somethingElse: true });
    writeJson('package.json', { fluidcad: { engine: '0.0.38' } });

    const config = readProjectConfig(workspace);

    expect(config.engine).toBe('0.0.38');
    expect(config.error).toBeUndefined();
  });

  it('reads back empty for a workspace with no config at all', () => {
    const config = readProjectConfig(workspace);

    expect(config).toEqual({ engine: null, source: null, filePath: null });
  });

  it('reads back empty for an empty workspace path', () => {
    expect(readProjectConfig('').engine).toBeNull();
  });

  it('reports unparseable fluidcad.json instead of throwing', () => {
    write(PROJECT_CONFIG_FILENAME, '{ "engine": ');

    const config = readProjectConfig(workspace);

    expect(config.engine).toBeNull();
    expect(config.error).toContain('not valid JSON');
  });

  it('reports an engine that is not a version string', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: 41 });

    const config = readProjectConfig(workspace);

    expect(config.engine).toBeNull();
    expect(config.error).toContain('not a version string');
  });

  it('stays quiet about a workspace package.json it cannot parse', () => {
    // Not our file to complain about — npm will say so far more usefully.
    write('package.json', 'not json at all');

    const config = readProjectConfig(workspace);

    expect(config.engine).toBeNull();
    expect(config.error).toBeUndefined();
  });

  it('ignores a non-object fluidcad field in package.json', () => {
    writeJson('package.json', { fluidcad: 'yes please' });

    expect(readProjectConfig(workspace).engine).toBeNull();
  });

  it('trims surrounding whitespace off the pin', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '  0.0.41  ' });

    expect(readProjectConfig(workspace).engine).toBe('0.0.41');
  });
});

describe('writeEnginePin', () => {
  it('creates fluidcad.json with the pin', () => {
    writeEnginePin(workspace, '0.0.41');

    expect(readProjectConfig(workspace).engine).toBe('0.0.41');
    expect(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8'))
      .toBe('{\n  "engine": "0.0.41"\n}\n');
  });

  it('preserves other keys when updating an existing pin', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.38', keepMe: { nested: 1 } });

    writeEnginePin(workspace, '0.0.41');

    const written = JSON.parse(
      fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8'),
    );
    expect(written).toEqual({ engine: '0.0.41', keepMe: { nested: 1 } });
  });

  it('does not rewrite package.json even when the pin came from there', () => {
    writeJson('package.json', { name: 'my-model', fluidcad: { engine: '0.0.38' } });

    writeEnginePin(workspace, '0.0.41');

    const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    expect(pkg.fluidcad.engine).toBe('0.0.38');
    expect(readProjectConfig(workspace).source).toBe('fluidcad.json');
  });

  it('overwrites a fluidcad.json it cannot parse rather than failing', () => {
    write(PROJECT_CONFIG_FILENAME, '}}} garbage');

    writeEnginePin(workspace, '0.0.41');

    expect(readProjectConfig(workspace).engine).toBe('0.0.41');
  });
});

describe('describeEnginePinMismatch', () => {
  it('is silent when the pin matches the running engine', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41' });

    expect(describeEnginePinMismatch(readProjectConfig(workspace), '0.0.41')).toBeNull();
  });

  it('is silent when there is no pin', () => {
    expect(describeEnginePinMismatch(readProjectConfig(workspace), '0.0.41')).toBeNull();
  });

  it('names both versions and the source when they differ', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.38' });

    const warning = describeEnginePinMismatch(readProjectConfig(workspace), '0.0.41');

    expect(warning).toContain('0.0.38');
    expect(warning).toContain('0.0.41');
    expect(warning).toContain('fluidcad.json');
  });

  it('surfaces a malformed config as its own warning', () => {
    write(PROJECT_CONFIG_FILENAME, '{ nope');

    const warning = describeEnginePinMismatch(readProjectConfig(workspace), '0.0.41');

    expect(warning).toContain('Ignoring the engine pin');
  });
});

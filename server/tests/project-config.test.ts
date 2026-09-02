import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readProjectConfig,
  writeEnginePin,
  writeProjectUnit,
  parseProjectUnit,
  describeEnginePinMismatch,
  describeProjectUnitProblem,
  isProjectUnitError,
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

    expect(config).toEqual({ engine: null, source: null, filePath: null, unit: null });
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

describe('readProjectConfig — unit', () => {
  it('reads back null when the project sets no unit (an mm project)', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41' });

    const config = readProjectConfig(workspace);

    expect(config.unit).toBeNull();
    expect(config.error).toBeUndefined();
  });

  it('reads the unit from fluidcad.json alongside the pin', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41', unit: 'in' });

    const config = readProjectConfig(workspace);

    expect(config.unit).toBe('in');
    expect(config.engine).toBe('0.0.41');
  });

  it('reads a unit-only fluidcad.json without complaining about the pin', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { unit: 'cm' });

    const config = readProjectConfig(workspace);

    expect(config.unit).toBe('cm');
    expect(config.engine).toBeNull();
    expect(config.error).toBeUndefined();
  });

  it('canonicalises aliases and case', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { unit: ' Inches ' });

    expect(readProjectConfig(workspace).unit).toBe('in');
  });

  it('falls back to package.json for the unit, key by key', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41' });
    writeJson('package.json', { fluidcad: { engine: '0.0.38', unit: 'ft' } });

    const config = readProjectConfig(workspace);

    expect(config.engine).toBe('0.0.41');
    expect(config.unit).toBe('ft');
  });

  it('prefers the fluidcad.json unit over package.json', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { unit: 'm' });
    writeJson('package.json', { fluidcad: { unit: 'ft' } });

    expect(readProjectConfig(workspace).unit).toBe('m');
  });

  it('reports an unknown unit and reads back null, keeping the pin', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41', unit: 'furlongs' });

    const config = readProjectConfig(workspace);

    expect(config.unit).toBeNull();
    expect(config.engine).toBe('0.0.41');
    expect(config.error).toContain('"unit"');
    expect(config.error).toContain('furlongs');
    expect(isProjectUnitError(config)).toBe(true);
  });

  it('reports a unit that is not a string', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { unit: 25.4 });

    const config = readProjectConfig(workspace);

    expect(config.unit).toBeNull();
    expect(config.error).toContain('"unit"');
  });

  it('does not let a bad unit in fluidcad.json fall through to package.json', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { unit: 'nope' });
    writeJson('package.json', { fluidcad: { unit: 'in' } });

    const config = readProjectConfig(workspace);

    expect(config.unit).toBeNull();
    expect(config.error).toContain('"unit"');
  });
});

describe('parseProjectUnit', () => {
  it('accepts the five short codes', () => {
    expect(['mm', 'cm', 'm', 'in', 'ft'].map(parseProjectUnit)).toEqual(['mm', 'cm', 'm', 'in', 'ft']);
  });

  it('accepts the spelled-out forms and symbols', () => {
    expect(parseProjectUnit('millimetres')).toBe('mm');
    expect(parseProjectUnit('Meter')).toBe('m');
    expect(parseProjectUnit('"')).toBe('in');
    expect(parseProjectUnit("'")).toBe('ft');
  });

  it('rejects everything else', () => {
    expect(parseProjectUnit('yd')).toBeNull();
    expect(parseProjectUnit(25.4)).toBeNull();
    expect(parseProjectUnit(undefined)).toBeNull();
  });
});

describe('writeProjectUnit', () => {
  it('creates fluidcad.json with just the unit', () => {
    writeProjectUnit(workspace, 'in');

    expect(readProjectConfig(workspace).unit).toBe('in');
    expect(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8'))
      .toBe('{\n  "unit": "in"\n}\n');
  });

  it('preserves the pin and other keys', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41', keepMe: true });

    writeProjectUnit(workspace, 'cm');

    const written = JSON.parse(
      fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8'),
    );
    expect(written).toEqual({ engine: '0.0.41', keepMe: true, unit: 'cm' });
  });

  it('survives a later writeEnginePin', () => {
    writeProjectUnit(workspace, 'ft');

    writeEnginePin(workspace, '0.0.42');

    const config = readProjectConfig(workspace);
    expect(config.unit).toBe('ft');
    expect(config.engine).toBe('0.0.42');
  });
});

describe('describeProjectUnitProblem', () => {
  it('is silent for a good or absent unit', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { unit: 'in' });

    expect(describeProjectUnitProblem(readProjectConfig(workspace))).toBeNull();
    expect(describeProjectUnitProblem(readProjectConfig(''))).toBeNull();
  });

  it('names the bad value and the fallback', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41', unit: 'yards' });

    const config = readProjectConfig(workspace);

    expect(describeProjectUnitProblem(config)).toContain('yards');
    expect(describeProjectUnitProblem(config)).toContain('Using mm');
    // The pin is fine — the engine warning must not claim otherwise.
    expect(describeEnginePinMismatch(config, '0.0.41')).toBeNull();
  });

  it('stays quiet about a parse error, which is the pin warning\'s job', () => {
    write(PROJECT_CONFIG_FILENAME, '{ nope');

    const config = readProjectConfig(workspace);

    expect(describeProjectUnitProblem(config)).toBeNull();
    expect(describeEnginePinMismatch(config, '0.0.41')).toContain('Ignoring the engine pin');
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

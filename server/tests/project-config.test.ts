import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readProjectConfig,
  writeEnginePin,
  writeProjectUnit,
  writeProjectMaterials,
  parseProjectUnit,
  describeEnginePinMismatch,
  describeProjectUnitProblem,
  describeProjectMaterialsProblem,
  isProjectUnitError,
  isProjectMaterialsError,
  isProjectPackageError,
  isProjectDependenciesError,
  isProjectConfigUnreadable,
  describeProjectPackageProblem,
  describeProjectDependenciesProblem,
  writePackageInfo,
  writeDependency,
  removeDependency,
  PROJECT_CONFIG_FILENAME,
  type PackageInfo,
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

    expect(config).toEqual({
      engine: null, source: null, filePath: null, unit: null, materials: null, package: null, dependencies: null,
    });
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

describe('readProjectConfig — materials', () => {
  it('reads a valid map, leaving densityUnit to the merge default when absent', () => {
    writeJson(PROJECT_CONFIG_FILENAME, {
      unit: 'mm',
      materials: {
        'alloy-steel': { name: 'Alloy Steel', density: 7.7, densityUnit: 'g/cm³' },
        'acme-pla': { name: 'ACME PLA+', density: 1.27 },
      },
    });

    const config = readProjectConfig(workspace);

    expect(config.error).toBeUndefined();
    expect(config.unit).toBe('mm');
    expect(config.materials).toEqual({
      'alloy-steel': { name: 'Alloy Steel', density: 7.7, densityUnit: 'g/cm³' },
      'acme-pla': { name: 'ACME PLA+', density: 1.27 },
    });
  });

  it('is null when the project declares none', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { unit: 'in' });
    expect(readProjectConfig(workspace).materials).toBeNull();
    expect(readProjectConfig(workspace).error).toBeUndefined();
  });

  it('falls back to package.json fluidcad.materials', () => {
    writeJson('package.json', { fluidcad: { materials: { pine: { name: 'Pine', density: 0.5 } } } });
    expect(readProjectConfig(workspace).materials).toEqual({ pine: { name: 'Pine', density: 0.5 } });
  });

  it.each([
    ['a non-object map', { materials: ['x'] }, 'not a map'],
    ['an empty id', { materials: { '': { name: 'X', density: 1 } } }, 'empty id'],
    ['a non-object entry', { materials: { x: 7 } }, 'not an object'],
    ['a missing name', { materials: { x: { density: 1 } } }, 'without a "name"'],
    ['a non-string name', { materials: { x: { name: 3, density: 1 } } }, 'without a "name"'],
    ['a zero density', { materials: { x: { name: 'X', density: 0 } } }, '"density" is not a positive number'],
    ['a non-finite density', { materials: { x: { name: 'X', density: 'lots' } } }, '"density" is not a positive number'],
    ['a bad density unit', { materials: { x: { name: 'X', density: 1, densityUnit: 'stone/ft³' } } }, '"densityUnit"'],
  ])('rejects %s, dropping the whole map and reporting it', (_label, json, fragment) => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41', unit: 'mm', ...json });

    const config = readProjectConfig(workspace);

    expect(config.materials).toBeNull();
    expect(config.error).toContain('"materials"');
    expect(config.error).toContain(fragment);
    expect(isProjectMaterialsError(config)).toBe(true);
    expect(isProjectUnitError(config)).toBe(false);
    // The pin and the unit are unaffected by a bad materials map.
    expect(config.engine).toBe('0.0.41');
    expect(config.unit).toBe('mm');
    expect(describeEnginePinMismatch(config, '0.0.41')).toBeNull();
    expect(describeProjectUnitProblem(config)).toBeNull();
    expect(describeProjectMaterialsProblem(config)).toContain('Ignoring the project materials');
  });

  it('writeProjectMaterials keeps every other key', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.41', unit: 'in', modelId: 'm1' });
    writeProjectMaterials(workspace, { pine: { name: 'Pine', density: 0.5 } });
    const stored = JSON.parse(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8'));
    expect(stored).toEqual({ engine: '0.0.41', unit: 'in', modelId: 'm1', materials: { pine: { name: 'Pine', density: 0.5 } } });
  });
});

const INTEGRITY = 'sha256-' + 'A'.repeat(42) + 'E=';
const OTHER_INTEGRITY = 'sha256-' + 'b'.repeat(43) + '=';

const GEARS: PackageInfo = {
  name: '@acme/gears',
  version: '1.2.0',
  exports: ['gear.feature.js', 'parts/spur.part.js'],
};

function readStored(): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8'));
}

describe('readProjectConfig — package', () => {
  it('is null for a plain project', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.46', unit: 'mm' });

    const config = readProjectConfig(workspace);

    expect(config.package).toBeNull();
    expect(config.dependencies).toBeNull();
    expect(config.error).toBeUndefined();
    expect(config.problems).toBeUndefined();
  });

  it('reads the required fields', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.46', package: GEARS });

    const config = readProjectConfig(workspace);

    expect(config.package).toEqual(GEARS);
    expect(config.error).toBeUndefined();
    expect(isProjectPackageError(config)).toBe(false);
  });

  it('reads every optional field, a prerelease version and an assembly export', () => {
    const full = {
      name: '@acme-robotics/gear-train-2',
      version: '2.0.0-rc.1',
      description: 'Spur gears and a gear-train feature',
      exports: ['gear.feature.js', 'train.assembly.js'],
      license: 'MIT',
      author: 'Acme Robotics',
      homepage: 'https://example.com/gears',
      keywords: ['gears', 'power transmission'],
      minEngine: '0.0.46',
    };
    writeJson(PROJECT_CONFIG_FILENAME, { package: full });

    expect(readProjectConfig(workspace).package).toEqual(full);
  });

  it('accepts an empty exports list (pack is what refuses a package with nothing to ship)', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { package: { ...GEARS, exports: [] } });

    expect(readProjectConfig(workspace).package?.exports).toEqual([]);
  });

  it('drops keys it does not read from the parsed block', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { package: { ...GEARS, futureField: { x: 1 } } });

    expect(readProjectConfig(workspace).package).toEqual(GEARS);
  });

  it('never reads a package from package.json, whose name and version are npm\'s', () => {
    writeJson('package.json', { name: '@acme/gears', version: '1.0.0', fluidcad: { package: GEARS } });

    expect(readProjectConfig(workspace).package).toBeNull();
  });

  it.each([
    ['a non-object block', ['@acme/gears'], 'that is not an object'],
    ['a missing name', { version: '1.0.0', exports: [] }, 'without a "name"'],
    ['an unscoped name', { ...GEARS, name: 'gears' }, '"name" "gears" is not a package name'],
    ['an upper-case name', { ...GEARS, name: '@Acme/gears' }, 'is not a package name'],
    ['an underscore in the name', { ...GEARS, name: '@acme/spur_gears' }, 'is not a package name'],
    ['a name starting with a dash', { ...GEARS, name: '@acme/-gears' }, 'is not a package name'],
    ['a scope over 39 characters', { ...GEARS, name: `@${'a'.repeat(40)}/gears` }, 'is not a package name'],
    ['a name over 64 characters', { ...GEARS, name: `@acme/${'g'.repeat(65)}` }, 'is not a package name'],
    ['a non-string name', { ...GEARS, name: 7 }, 'is not a package name'],
    ['a missing version', { name: '@acme/gears', exports: [] }, 'without a "version"'],
    ['a two-part version', { ...GEARS, version: '1.2' }, '"version" "1.2" is not a semver version'],
    ['a v-prefixed version', { ...GEARS, version: 'v1.2.0' }, 'is not a semver version'],
    ['a version range', { ...GEARS, version: '^1.2.0' }, 'is not a semver version'],
    ['build metadata', { ...GEARS, version: '1.2.0+build.5' }, 'is not a semver version'],
    ['a leading zero', { ...GEARS, version: '01.2.0' }, 'is not a semver version'],
    ['a numeric version', { ...GEARS, version: 1 }, 'is not a semver version'],
    ['missing exports', { name: '@acme/gears', version: '1.0.0' }, 'without "exports"'],
    ['exports that are not a list', { ...GEARS, exports: 'gear.feature.js' }, '"exports" is not a list'],
    ['a non-string export', { ...GEARS, exports: [3] }, 'that is not a module path'],
    ['an empty export', { ...GEARS, exports: [''] }, 'that is not a module path'],
    ['a plain script export', { ...GEARS, exports: ['helpers/involute.js'] }, 'is not a *.feature.js, *.part.js, *.assembly.js module'],
    ['a .fluid.js export', { ...GEARS, exports: ['demo.fluid.js'] }, 'is not a *.feature.js'],
    ['an absolute export', { ...GEARS, exports: ['/abs/gear.feature.js'] }, 'is not a path inside the workspace'],
    ['an export leaving the workspace', { ...GEARS, exports: ['../gear.feature.js'] }, 'is not a path inside the workspace'],
    ['a dot segment', { ...GEARS, exports: ['./gear.feature.js'] }, 'is not a path inside the workspace'],
    ['a backslash', { ...GEARS, exports: ['parts\\spur.part.js'] }, 'is not a path inside the workspace'],
    ['a drive letter', { ...GEARS, exports: ['C:gear.feature.js'] }, 'is not a path inside the workspace'],
    ['a duplicate export', { ...GEARS, exports: ['gear.feature.js', 'gear.feature.js'] }, 'lists "gear.feature.js" twice'],
    ['a non-string description', { ...GEARS, description: 5 }, '"description" is not a string'],
    ['a non-string license', { ...GEARS, license: ['MIT'] }, '"license" is not a string'],
    ['a non-string author', { ...GEARS, author: { name: 'Acme' } }, '"author" is not a string'],
    ['a non-string homepage', { ...GEARS, homepage: true }, '"homepage" is not a string'],
    ['keywords that are not a list', { ...GEARS, keywords: 'gears' }, '"keywords" is not a list of strings'],
    ['a non-string keyword', { ...GEARS, keywords: ['gears', 2] }, '"keywords" is not a list of strings'],
    ['a bad minEngine', { ...GEARS, minEngine: '0.0' }, '"minEngine" "0.0" is not a semver version'],
  ])('rejects %s, dropping the whole block and reporting it on its own', (_label, block, fragment) => {
    writeJson(PROJECT_CONFIG_FILENAME, {
      engine: '0.0.46',
      unit: 'in',
      materials: { pine: { name: 'Pine', density: 0.5 } },
      dependencies: { '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY } },
      package: block,
    });

    const config = readProjectConfig(workspace);

    expect(config.package).toBeNull();
    expect(config.error).toContain('"package"');
    expect(config.error).toContain(fragment);
    expect(config.problems?.package).toBe(config.error);
    expect(isProjectPackageError(config)).toBe(true);
    // Nothing else in the file is lost or blamed.
    expect(config.engine).toBe('0.0.46');
    expect(config.unit).toBe('in');
    expect(config.materials).toEqual({ pine: { name: 'Pine', density: 0.5 } });
    expect(config.dependencies).toEqual({ '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY } });
    expect(isProjectUnitError(config)).toBe(false);
    expect(isProjectMaterialsError(config)).toBe(false);
    expect(isProjectDependenciesError(config)).toBe(false);
    expect(describeEnginePinMismatch(config, '0.0.46')).toBeNull();
    expect(describeProjectUnitProblem(config)).toBeNull();
    expect(describeProjectMaterialsProblem(config)).toBeNull();
    expect(describeProjectDependenciesProblem(config)).toBeNull();
    expect(describeProjectPackageProblem(config)).toContain('Treating this workspace as a plain project');
  });

  it('is not mistaken for a unit problem when an export path spells "unit"', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { unit: 'in', package: { ...GEARS, exports: ['unit'] } });

    const config = readProjectConfig(workspace);

    expect(config.error).toContain('"unit"');
    expect(isProjectPackageError(config)).toBe(true);
    expect(isProjectUnitError(config)).toBe(false);
    expect(config.unit).toBe('in');
  });

  it('keeps the package and the pins when the engine pin is bad', () => {
    writeJson(PROJECT_CONFIG_FILENAME, {
      engine: 46,
      package: GEARS,
      dependencies: { '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY } },
    });

    const config = readProjectConfig(workspace);

    expect(config.engine).toBeNull();
    expect(config.package).toEqual(GEARS);
    expect(config.dependencies).toEqual({ '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY } });
    expect(isProjectPackageError(config)).toBe(false);
    expect(describeEnginePinMismatch(config, '0.0.46')).toContain('Ignoring the engine pin');
  });

  it('reports a bad engine and a bad package side by side, each with its own warning', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: 46, package: { ...GEARS, version: '1' } });

    const config = readProjectConfig(workspace);

    expect(describeEnginePinMismatch(config, '0.0.46')).toContain('"engine"');
    expect(describeEnginePinMismatch(config, '0.0.46')).not.toContain('"package"');
    expect(describeProjectPackageProblem(config)).toContain('"version" "1"');
    expect(describeProjectPackageProblem(config)).not.toContain('"engine"');
  });

  it('reads as unreadable, not as a bad package, when the file is not JSON', () => {
    write(PROJECT_CONFIG_FILENAME, '{ "package": ');

    const config = readProjectConfig(workspace);

    expect(isProjectConfigUnreadable(config)).toBe(true);
    expect(isProjectPackageError(config)).toBe(false);
    expect(config.package).toBeNull();
    expect(describeEnginePinMismatch(config, '0.0.46')).toContain('not valid JSON');
  });
});

describe('readProjectConfig — dependencies', () => {
  it('reads exact pins', () => {
    const dependencies = {
      '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY },
      '@other/gears': { version: '1.0.0-beta.2', integrity: OTHER_INTEGRITY },
    };
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.46', dependencies });

    const config = readProjectConfig(workspace);

    expect(config.dependencies).toEqual(dependencies);
    expect(config.error).toBeUndefined();
  });

  it('reads an empty map as no pins, without complaint', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { dependencies: {} });

    const config = readProjectConfig(workspace);

    expect(config.dependencies).toEqual({});
    expect(config.error).toBeUndefined();
  });

  it('keeps only the version and the integrity of a pin', () => {
    writeJson(PROJECT_CONFIG_FILENAME, {
      dependencies: { '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY, note: 'x' } },
    });

    expect(readProjectConfig(workspace).dependencies).toEqual({
      '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY },
    });
  });

  it('never reads pins from package.json, whose dependencies are npm\'s', () => {
    writeJson('package.json', { dependencies: { '@acme/fasteners': '2.0.1' }, fluidcad: { engine: '0.0.46' } });

    expect(readProjectConfig(workspace).dependencies).toBeNull();
  });

  it.each([
    ['a list', ['@acme/fasteners'], 'that is not a map of package name'],
    ['an unscoped key', { fasteners: { version: '2.0.1', integrity: INTEGRITY } }, 'a key "fasteners" that is not a package name'],
    ['a bare version string', { '@acme/fasteners': '2.0.1' }, 'that is not an object { version, integrity }'],
    ['a version range', { '@acme/fasteners': { version: '^2.0.1', integrity: INTEGRITY } }, 'is not an exact version'],
    ['a missing version', { '@acme/fasteners': { integrity: INTEGRITY } }, '"@acme/fasteners" without a "version"'],
    ['a missing integrity', { '@acme/fasteners': { version: '2.0.1' } }, '"integrity" is not a sha256-<base64> tree hash'],
    ['another algorithm', { '@acme/fasteners': { version: '2.0.1', integrity: 'sha512-abc=' } }, '"integrity" is not a sha256'],
    ['a short digest', { '@acme/fasteners': { version: '2.0.1', integrity: 'sha256-abc=' } }, '"integrity" is not a sha256'],
  ])('rejects %s, dropping the whole map and reporting it on its own', (_label, dependencies, fragment) => {
    writeJson(PROJECT_CONFIG_FILENAME, {
      engine: '0.0.46',
      unit: 'cm',
      materials: { pine: { name: 'Pine', density: 0.5 } },
      package: GEARS,
      dependencies,
    });

    const config = readProjectConfig(workspace);

    expect(config.dependencies).toBeNull();
    expect(config.error).toContain('"dependencies"');
    expect(config.error).toContain(fragment);
    expect(isProjectDependenciesError(config)).toBe(true);
    expect(config.engine).toBe('0.0.46');
    expect(config.unit).toBe('cm');
    expect(config.materials).toEqual({ pine: { name: 'Pine', density: 0.5 } });
    expect(config.package).toEqual(GEARS);
    expect(isProjectPackageError(config)).toBe(false);
    expect(isProjectUnitError(config)).toBe(false);
    expect(isProjectMaterialsError(config)).toBe(false);
    expect(describeEnginePinMismatch(config, '0.0.46')).toBeNull();
    expect(describeProjectPackageProblem(config)).toBeNull();
    expect(describeProjectDependenciesProblem(config)).toContain('Ignoring the project\'s package pins');
  });

  it('reports a bad unit, materials, package and dependencies all at once, each on its own', () => {
    writeJson(PROJECT_CONFIG_FILENAME, {
      engine: '0.0.46',
      unit: 'yards',
      materials: { x: { name: 'X', density: 0 } },
      package: { ...GEARS, name: 'gears' },
      dependencies: { '@acme/fasteners': { version: 'latest', integrity: INTEGRITY } },
    });

    const config = readProjectConfig(workspace);

    expect(config.engine).toBe('0.0.46');
    expect(describeProjectUnitProblem(config)).toContain('yards');
    expect(describeProjectUnitProblem(config)).not.toContain('"package"');
    expect(describeProjectMaterialsProblem(config)).toContain('"density"');
    expect(describeProjectPackageProblem(config)).toContain('"gears"');
    expect(describeProjectDependenciesProblem(config)).toContain('"latest"');
    for (const sentence of Object.values(config.problems ?? {})) {
      expect(config.error).toContain(sentence);
    }
  });
});

describe('writePackageInfo', () => {
  it('creates fluidcad.json with just the block, in the canonical key order', () => {
    writePackageInfo(workspace, { exports: ['gear.feature.js'], version: '0.1.0', name: '@acme/gears' });

    expect(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8')).toBe(
      '{\n  "package": {\n    "name": "@acme/gears",\n    "version": "0.1.0",\n    "exports": [\n      "gear.feature.js"\n    ]\n  }\n}\n',
    );
    expect(readProjectConfig(workspace).package).toEqual({
      name: '@acme/gears', version: '0.1.0', exports: ['gear.feature.js'],
    });
  });

  it('keeps every other key of the file', () => {
    writeJson(PROJECT_CONFIG_FILENAME, {
      engine: '0.0.46', unit: 'in', modelId: 'm1', name: 'Old publish name',
      materials: { pine: { name: 'Pine', density: 0.5 } },
      dependencies: { '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY } },
    });

    writePackageInfo(workspace, GEARS);

    expect(readStored()).toEqual({
      engine: '0.0.46', unit: 'in', modelId: 'm1', name: 'Old publish name',
      materials: { pine: { name: 'Pine', density: 0.5 } },
      dependencies: { '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY } },
      package: GEARS,
    });
  });

  it('keeps the keys of the old block it does not read, and removes known keys left out', () => {
    writeJson(PROJECT_CONFIG_FILENAME, {
      package: { ...GEARS, license: 'MIT', futureField: { x: 1 } },
    });

    writePackageInfo(workspace, { ...GEARS, version: '1.3.0' });

    expect(readStored().package).toEqual({ ...GEARS, version: '1.3.0', futureField: { x: 1 } });
  });

  it('refuses a block that would read back invalid, leaving the file alone', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.46', package: GEARS });
    const before = fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8');

    expect(() => writePackageInfo(workspace, { ...GEARS, version: '1.3' })).toThrow('"version" "1.3"');
    expect(() => writePackageInfo(workspace, { ...GEARS, name: 'gears' })).toThrow('is not a package name');

    expect(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8')).toBe(before);
  });

  it('survives a later writeEnginePin and writeProjectUnit', () => {
    writePackageInfo(workspace, GEARS);

    writeEnginePin(workspace, '0.0.47');
    writeProjectUnit(workspace, 'cm');

    const config = readProjectConfig(workspace);
    expect(config.package).toEqual(GEARS);
    expect(config.engine).toBe('0.0.47');
    expect(config.unit).toBe('cm');
  });
});

describe('writeDependency / removeDependency', () => {
  it('creates the map with the first pin', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.46' });

    writeDependency(workspace, '@acme/fasteners', { version: '2.0.1', integrity: INTEGRITY });

    expect(readStored()).toEqual({
      engine: '0.0.46',
      dependencies: { '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY } },
    });
  });

  it('adds pins sorted by name, replaces an existing pin, and keeps every other key', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.46', unit: 'in', package: GEARS, keepMe: true });

    writeDependency(workspace, '@zeta/clips', { version: '1.0.0', integrity: INTEGRITY });
    writeDependency(workspace, '@acme/fasteners', { version: '2.0.1', integrity: INTEGRITY });
    writeDependency(workspace, '@zeta/clips', { version: '1.1.0', integrity: OTHER_INTEGRITY });

    const stored = readStored();
    expect(Object.keys(stored.dependencies)).toEqual(['@acme/fasteners', '@zeta/clips']);
    expect(stored.dependencies['@zeta/clips']).toEqual({ version: '1.1.0', integrity: OTHER_INTEGRITY });
    expect(stored).toMatchObject({ engine: '0.0.46', unit: 'in', package: GEARS, keepMe: true });
    expect(readProjectConfig(workspace).error).toBeUndefined();
  });

  it('writes only the version and the integrity', () => {
    writeDependency(workspace, '@acme/fasteners', { version: '2.0.1', integrity: INTEGRITY, extra: 1 } as any);

    expect(readStored().dependencies['@acme/fasteners']).toEqual({ version: '2.0.1', integrity: INTEGRITY });
  });

  it('refuses a pin that would read back invalid, leaving the file alone', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { engine: '0.0.46' });
    const before = fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8');

    expect(() => writeDependency(workspace, 'fasteners', { version: '2.0.1', integrity: INTEGRITY })).toThrow('not a package name');
    expect(() => writeDependency(workspace, '@acme/fasteners', { version: '^2.0.1', integrity: INTEGRITY })).toThrow('not an exact version');
    expect(() => writeDependency(workspace, '@acme/fasteners', { version: '2.0.1', integrity: 'md5-x' })).toThrow('"integrity"');

    expect(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8')).toBe(before);
  });

  it('never deletes the other entries, even ones that do not read back', () => {
    writeJson(PROJECT_CONFIG_FILENAME, { dependencies: { '@acme/broken': '2.0.1' } });

    writeDependency(workspace, '@acme/fasteners', { version: '2.0.1', integrity: INTEGRITY });

    expect(readStored().dependencies).toEqual({
      '@acme/broken': '2.0.1',
      '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY },
    });
  });

  it('removes one pin and keeps the rest', () => {
    writeJson(PROJECT_CONFIG_FILENAME, {
      engine: '0.0.46',
      dependencies: {
        '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY },
        '@zeta/clips': { version: '1.0.0', integrity: OTHER_INTEGRITY },
      },
    });

    removeDependency(workspace, '@acme/fasteners');

    expect(readStored()).toEqual({
      engine: '0.0.46',
      dependencies: { '@zeta/clips': { version: '1.0.0', integrity: OTHER_INTEGRITY } },
    });
  });

  it('removes the dependencies key with the last pin', () => {
    writeJson(PROJECT_CONFIG_FILENAME, {
      engine: '0.0.46',
      dependencies: { '@acme/fasteners': { version: '2.0.1', integrity: INTEGRITY } },
    });

    removeDependency(workspace, '@acme/fasteners');

    expect(readStored()).toEqual({ engine: '0.0.46' });
    expect(readProjectConfig(workspace).dependencies).toBeNull();
  });

  it('leaves the file untouched for a name that is not pinned, and creates none', () => {
    removeDependency(workspace, '@acme/fasteners');
    expect(fs.existsSync(path.join(workspace, PROJECT_CONFIG_FILENAME))).toBe(false);

    write(PROJECT_CONFIG_FILENAME, '{"engine":"0.0.46"}');
    removeDependency(workspace, '@acme/fasteners');
    expect(fs.readFileSync(path.join(workspace, PROJECT_CONFIG_FILENAME), 'utf8')).toBe('{"engine":"0.0.46"}');
  });
});

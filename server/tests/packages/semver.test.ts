import { describe, it, expect } from 'vitest';
import { Semver } from '../../src/packages/semver.ts';

function v(text: string): Semver {
  const parsed = Semver.parse(text);
  if (parsed === null) {
    throw new Error(`test version ${text} does not parse`);
  }
  return parsed;
}

describe('Semver.parse', () => {
  it.each([
    ['0.0.0', [0, 0, 0, []]],
    ['1.2.3', [1, 2, 3, []]],
    ['10.20.30', [10, 20, 30, []]],
    ['1.0.0-alpha', [1, 0, 0, ['alpha']]],
    ['1.0.0-alpha.1', [1, 0, 0, ['alpha', '1']]],
    ['1.0.0-0.3.7', [1, 0, 0, ['0', '3', '7']]],
    ['1.0.0-x-y-z.--', [1, 0, 0, ['x-y-z', '--']]],
    ['1.0.0-0a.01b', [1, 0, 0, ['0a', '01b']]],
  ])('reads %s', (text, [major, minor, patch, prerelease]) => {
    const parsed = v(text);
    expect([parsed.major, parsed.minor, parsed.patch, [...parsed.prerelease]]).toEqual([major, minor, patch, prerelease]);
    expect(parsed.toString()).toBe(text);
  });

  it.each([
    '1', '1.2', '1.2.3.4', 'v1.2.3', ' 1.2.3', '1.2.3 ', '01.2.3', '1.02.3', '1.2.03',
    '1.2.3-', '1.2.3-01', '1.2.3-alpha..1', '1.2.3-al$pha', '1.2.3+build', '1.2.3-beta+exp.sha.5114f85',
    '^1.2.3', '~1.2.3', '>=1.2.3', '1.2.x', '*', 'latest', '', '9007199254740993.0.0',
  ])('refuses %j', (text) => {
    expect(Semver.parse(text)).toBeNull();
    expect(Semver.isValid(text)).toBe(false);
  });

  it('refuses what is not a string', () => {
    expect(Semver.parse(1)).toBeNull();
    expect(Semver.parse(undefined)).toBeNull();
    expect(Semver.parse({ major: 1 })).toBeNull();
  });
});

describe('Semver precedence', () => {
  it('orders the semver.org example chain', () => {
    const chain = [
      '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2',
      '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '2.0.0', '2.1.0', '2.1.1',
    ];
    for (let i = 0; i + 1 < chain.length; i++) {
      expect(Semver.compare(v(chain[i]), v(chain[i + 1]))).toBe(-1);
      expect(Semver.compare(v(chain[i + 1]), v(chain[i]))).toBe(1);
    }
    const shuffled = [...chain].reverse().map(v).sort(Semver.compare).map(String);
    expect(shuffled).toEqual(chain);
  });

  it('compares numbers as numbers, not text', () => {
    expect(v('1.10.0').compareTo(v('1.9.0'))).toBe(1);
    expect(v('1.0.0-rc.10').compareTo(v('1.0.0-rc.9'))).toBe(1);
    expect(v('1.0.0-12345678901234567890').compareTo(v('1.0.0-12345678901234567891'))).toBe(-1);
  });

  it('sorts numeric identifiers before alphanumeric ones', () => {
    expect(v('1.0.0-1').compareTo(v('1.0.0-a'))).toBe(-1);
  });

  it('treats equal versions as equal', () => {
    expect(v('1.2.3-beta.1').equals(v('1.2.3-beta.1'))).toBe(true);
    expect(v('1.2.3').equals(v('1.2.4'))).toBe(false);
  });
});

describe('Semver.bump', () => {
  it.each([
    ['1.2.3', 'patch', '1.2.4'],
    ['1.2.3', 'minor', '1.3.0'],
    ['1.2.3', 'major', '2.0.0'],
    ['0.1.0', 'patch', '0.1.1'],
    ['0.1.0', 'minor', '0.2.0'],
    ['0.1.0', 'major', '1.0.0'],
    // A prerelease is released by the bump that names its own core.
    ['1.2.3-beta.1', 'patch', '1.2.3'],
    ['1.3.0-beta', 'minor', '1.3.0'],
    ['2.0.0-rc.1', 'major', '2.0.0'],
    // Otherwise the bump moves past it.
    ['1.2.3-beta', 'minor', '1.3.0'],
    ['1.2.0-beta', 'major', '2.0.0'],
    ['1.0.1-beta', 'major', '2.0.0'],
  ] as const)('%s + %s = %s', (from, kind, to) => {
    expect(v(from).bump(kind).toString()).toBe(to);
  });

  it('always moves forward', () => {
    for (const from of ['0.0.0', '1.2.3', '1.2.3-beta', '1.3.0-beta', '2.0.0-rc.1']) {
      for (const kind of Semver.BUMPS) {
        expect(v(from).bump(kind).compareTo(v(from))).toBe(1);
      }
    }
  });

  it('knows its bump names', () => {
    expect(Semver.BUMPS.every((kind) => Semver.isBump(kind))).toBe(true);
    expect(Semver.isBump('prerelease')).toBe(false);
    expect(Semver.isBump('1.2.3')).toBe(false);
  });
});

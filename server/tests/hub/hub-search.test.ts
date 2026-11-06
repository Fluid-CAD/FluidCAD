import { describe, it, expect } from 'vitest';
import type { HubBridgeSearchResponse, HubBridgeSearchResult } from '../../src/hub/hub-bridge.ts';
import { HubProxyPaths } from '../../src/hub/hub-proxy-paths.ts';
import { HubRequestError } from '../../src/hub/hub-request-error.ts';
import { HubSearchQuery } from '../../src/hub/hub-search-query.ts';
import { HubSearchText } from '../../src/hub/hub-search-text.ts';
import { SearchFixture } from '../fixtures/search-fixture.ts';

/**
 * The search pieces the bridge and `fluidcad search` share (hub-plan H10,
 * from the user's search design of 2026-10-11): the request in the hub's
 * names with the engine added, the proxy paths, the hub's refusal
 * sentence, and the terminal's rows and footer.
 */

const HUB = 'http://127.0.0.1:8787';
/** The engine a search named, as the answer echoes it: FluidCAD 0.0.46 with feature SDK 1. */
const ASKED = { engine: '0.0.46', sdk: 1 };

function row(options: Partial<Parameters<typeof SearchFixture.row>[0]> = {}, local: Partial<HubBridgeSearchResult['local']> = {}): HubBridgeSearchResult {
  const { publisher, ...rest } = SearchFixture.row({ origin: HUB, ...options }) as any;
  return { ...rest, publisher: { handle: publisher.handle }, local: { installed: [], pinned: null, updateAvailable: null, ...local } };
}

function answer(results: HubBridgeSearchResult[], options: Parameters<typeof SearchFixture.answer>[1] = {}): HubBridgeSearchResponse {
  return { ...(SearchFixture.answer([], options) as any), results, total: options.total ?? results.length };
}

describe('HubSearchQuery', () => {
  it("reads the panel's query in the hub's names, the lists as repeated keys, and ignores the engine fields and any keyword it sends", () => {
    const query = HubSearchQuery.fromParams(new URLSearchParams(
      'q=+gear+box+&contents=features&contents=parts&contents=features&keyword=pcb&units=metric&license=MIT&sort=updated&order=asc&page=3&limit=10&engine=1.0.0&sdk=9&compatible=true&includeIncompatible=0&other=x',
    ));
    expect(query.fields).toEqual({
      q: 'gear box',
      contents: ['features', 'parts'],
      units: ['metric'],
      license: ['MIT'],
      sort: 'updated',
      order: 'asc',
      page: '3',
      limit: '10',
    });
  });

  it('sends this engine, every package (no compatible filter), no sort or order unless asked, in a fixed order', () => {
    const params = HubSearchQuery.from({ q: '@acme standoff', contents: ['parts'], license: ['MIT', 'Apache-2.0'] }).hubParams('0.0.46', 1);
    expect(params.toString()).toBe('q=%40acme+standoff&contents=parts&license=MIT&license=Apache-2.0&engine=0.0.46&sdk=1');
    // Keywords only feed the hub's matching of the words (2026-10-12): no keyword filter is ever sent.
    expect(HubSearchQuery.fromParams(new URLSearchParams('q=gear&keyword=pcb')).hubParams('0.0.46', 1).toString()).toBe('q=gear&engine=0.0.46&sdk=1');
    expect(HubSearchQuery.from().hubParams('0.0.46', 1).toString()).toBe('engine=0.0.46&sdk=1');
    // A panel that still sends the old toggle, or compatible itself, changes nothing.
    for (const extra of ['includeIncompatible=1', 'includeIncompatible=0', 'compatible=true']) {
      expect(HubSearchQuery.fromParams(new URLSearchParams(extra)).hubParams('0.0.46', 1).has('compatible')).toBe(false);
    }
  });

  it('sends the sort and its direction as asked, the direction after the sort', () => {
    expect(HubSearchQuery.from({ sort: 'installs', order: 'asc', page: '2' }).hubParams('0.0.46', 1).toString())
      .toBe('sort=installs&order=asc&page=2&engine=0.0.46&sdk=1');
    expect(HubSearchQuery.fromParams(new URLSearchParams('order=desc')).hubParams('0.0.46', 1).toString()).toBe('order=desc&engine=0.0.46&sdk=1');
    expect(HubSearchQuery.fromParams(new URLSearchParams('order=%20')).fields.order).toBeNull();
  });
});

describe('HubProxyPaths', () => {
  it("maps the hub's file and screenshot URLs to the engine's proxy paths, and anything else to null", () => {
    expect(HubProxyPaths.rewrite(`${HUB}/api/v1/packages/@acme/kit/versions/0.2.0/files/features/standoff.svg`, HUB)).toBe('api/hub/files/@acme/kit/0.2.0/features/standoff.svg');
    expect(HubProxyPaths.rewrite(`${HUB}/api/v1/packages/%40acme/kit/media/9fef2c3c-1f16`, HUB)).toBe('api/hub/media/@acme/kit/9fef2c3c-1f16');
    expect(HubProxyPaths.rewrite('https://elsewhere.example.com/api/v1/packages/@acme/kit/media/x', HUB)).toBeNull();
    expect(HubProxyPaths.rewrite(`${HUB}/api/v1/packages/@acme/kit/versions/0.2.0/archive`, HUB)).toBeNull();
    expect(HubProxyPaths.rewrite(`${HUB}/api/v1/packages/@acme/kit/media/x?y=1`, HUB)).toBeNull();
    expect(HubProxyPaths.rewrite(null, HUB)).toBeNull();
    expect(HubProxyPaths.rewrite('not a url', HUB)).toBeNull();
  });
});

describe('HubRequestError.sentence', () => {
  it("adds the fields a validation refusal names to the hub's sentence", () => {
    const err = new HubRequestError(400, 'bad-request', 'The request is not valid.', {
      details: { issues: [{ path: ['license', 0], message: 'Use one of the hub\'s licenses: MIT.' }, { path: ['sort'], message: 'Invalid option' }] },
    });
    expect(err.sentence).toBe("The request is not valid: license: Use one of the hub's licenses: MIT.; sort: Invalid option");
    expect(new HubRequestError(400, 'bad-request', 'page 999 starts past the first 1000 results.').sentence).toBe('page 999 starts past the first 1000 results.');
  });
});

describe('HubSearchText', () => {
  it('prints a row: name and version, the description on one line, chips with +N, contents, likes, installs and the license', () => {
    const lines = HubSearchText.row(row({
      fullName: '@mira/mounting',
      version: '1.1.0',
      description: 'PCB mounting hardware:\n standoffs, bolt circles.',
      chips: ['Standoff', 'Bolt circle', 'Boss'],
      moreFeatures: 2,
      counts: { features: 5, parts: 1, assemblies: 0 },
      likes: 1,
      installs: 4000,
      license: 'Apache-2.0',
    }), ASKED);
    expect(lines).toEqual([
      '@mira/mounting 1.1.0',
      '  PCB mounting hardware: standoffs, bolt circles.',
      '  Standoff, Bolt circle, Boss +2 · 5 features, 1 part · 1 like · 4,000 installs · Apache-2.0',
    ]);
  });

  it('marks installed, pinned and update available from the local state', () => {
    expect(HubSearchText.marks(row({ version: '0.2.0' }, { installed: ['0.2.0'], pinned: '0.2.0' }), ASKED)).toEqual(['installed', 'pinned']);
    expect(HubSearchText.marks(row({ version: '0.2.0' }, { installed: ['0.1.0'], pinned: '0.1.0', updateAvailable: '0.2.0' }), ASKED)).toEqual(['installed 0.1.0', 'pinned 0.1.0', 'update available']);
    expect(HubSearchText.marks(row({ version: '0.2.0' }, { installed: ['0.1.0', '0.2.0'] }), ASKED)).toEqual(['installed 0.1.0, 0.2.0']);
  });

  it('says why only when the hub says this FluidCAD cannot run it, and "deprecated" when set', () => {
    expect(HubSearchText.marks(row({ compatible: false, minEngine: '0.0.99' }), ASKED)).toEqual(['requires FluidCAD 0.0.99+']);
    expect(HubSearchText.marks(row({ compatible: true, minEngine: '0.0.99', sdkVersion: 2 }), ASKED)).toEqual([]);
    expect(HubSearchText.marks(row({ compatible: null, minEngine: '0.0.99', sdkVersion: 2 }), ASKED)).toEqual([]);
    expect(HubSearchText.marks(row({ deprecated: 'Use @acme/kit2 instead.' }), ASKED)).toEqual(['deprecated: Use @acme/kit2 instead.']);
    expect(HubSearchText.row(row({ compatible: false, minEngine: '0.1.0', deprecated: 'Old.' }), ASKED)[0]).toBe('@acme/kit 0.2.0 · requires FluidCAD 0.1.0+ · deprecated: Old.');
  });

  it("names one reason from the row's minEngine and sdkVersion: a newer FluidCAD, else made for an older one (H11 decision 3)", () => {
    // minEngine above the engine that asked (prereleases by semver precedence), whatever the SDK.
    expect(HubSearchText.marks(row({ compatible: false, minEngine: '0.0.47', sdkVersion: 1 }), ASKED)).toEqual(['requires FluidCAD 0.0.47+']);
    expect(HubSearchText.marks(row({ compatible: false, minEngine: '0.1.0-beta.1', sdkVersion: 1 }), ASKED)).toEqual(['requires FluidCAD 0.1.0-beta.1+']);
    // A newer SDK: pack keeps its minEngine at or above that SDK's first FluidCAD, so the engine says it.
    expect(HubSearchText.marks(row({ compatible: false, minEngine: '0.1.0', sdkVersion: 2 }), ASKED)).toEqual(['requires FluidCAD 0.1.0+']);
    // minEngine met, packed for an older SDK than this engine's (after a breaking SDK bump).
    expect(HubSearchText.marks(row({ compatible: false, minEngine: '0.0.40', sdkVersion: 1 }), { engine: '0.1.0', sdk: 2 })).toEqual(['made for an older FluidCAD']);
    expect(HubSearchText.incompatibility({ minEngine: '0.0.99', sdkVersion: 1 }, ASKED)).toEqual({ kind: 'engine', minEngine: '0.0.99' });
    expect(HubSearchText.incompatibility({ minEngine: '0.0.40', sdkVersion: 1 }, { engine: '0.1.0', sdk: 2 })).toEqual({ kind: 'older-sdk' });
  });

  it('names no reason when neither rule explains it, rather than guessing', () => {
    // minEngine met and the same SDK: the hub's rule changed, or the echo lacks what it compared.
    expect(HubSearchText.marks(row({ compatible: false, minEngine: '0.0.46', sdkVersion: 1 }), ASKED)).toEqual(['not compatible with this FluidCAD']);
    // A newer SDK whose minEngine is met breaks pack's rule: no guess.
    expect(HubSearchText.marks(row({ compatible: false, minEngine: '0.0.46', sdkVersion: 2 }), ASKED)).toEqual(['not compatible with this FluidCAD']);
    expect(HubSearchText.marks(row({ compatible: false, minEngine: '0.0.40', sdkVersion: 1 }), { engine: '0.0.46', sdk: null })).toEqual(['not compatible with this FluidCAD']);
    expect(HubSearchText.marks(row({ compatible: false, minEngine: 'soon', sdkVersion: 1 }), ASKED)).toEqual(['not compatible with this FluidCAD']);
    // A hub from before the rows named their SDK.
    const { sdkVersion, ...older } = row({ compatible: false, minEngine: '0.0.46' });
    expect(HubSearchText.marks(older as HubBridgeSearchResult, ASKED)).toEqual(['not compatible with this FluidCAD']);
    expect(HubSearchText.marks({ ...older, minEngine: '0.0.99' } as HubBridgeSearchResult, ASKED)).toEqual(['requires FluidCAD 0.0.99+']);
  });

  it('cuts a long description, and prints "no license" and no chips when there are none', () => {
    const lines = HubSearchText.row(row({ description: 'word '.repeat(60), chips: [], counts: { features: 0, parts: 2, assemblies: 1 }, license: null }), ASKED);
    expect(lines[1].length).toBe(2 + HubSearchText.DESCRIPTION_CHARS);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(lines[2]).toBe('  2 parts, 1 assembly · 0 likes · 0 installs · no license');
  });

  it('pages in the footer: a range, the next page, 1,000+ when capped, the last page, and no match', () => {
    const twenty = Array.from({ length: 20 }, () => row());
    expect(HubSearchText.footer(answer(twenty, { total: 134 }))).toBe('1–20 of 134 · --page 2 for more');
    expect(HubSearchText.footer(answer(twenty, { total: 1000, capped: true, page: 3 }))).toBe('41–60 of 1,000+ · --page 4 for more');
    expect(HubSearchText.footer(answer(twenty, { total: 1000, capped: true, page: 50 }))).toBe('981–1,000 of 1,000+');
    expect(HubSearchText.footer(answer([row(), row(), row()], { total: 3 }))).toBe('1–3 of 3');
    expect(HubSearchText.footer(answer([], { total: 0 }))).toBe('No packages match.');
    expect(HubSearchText.footer(answer([], { total: 5, page: 2 }))).toBe('Nothing on page 2: 5 in all.');
  });

  it('prints every row, a blank line after each, then the footer', () => {
    expect(HubSearchText.lines(answer([row({ description: null })], { total: 1 }))).toEqual([
      '@acme/kit 0.2.0',
      '  Standoff · 1 feature · 0 likes · 0 installs · MIT',
      '',
      '1–1 of 1',
    ]);
  });
});

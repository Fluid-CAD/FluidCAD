// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpHubClient } from '../src/api';
import { HubPanelState, type HubTimers } from '../src/ui/hub/hub-panel-state';
import { HubSearchView } from '../src/ui/hub/hub-search-view';
import { HubText } from '../src/ui/hub/hub-text';
import { FakeHubClient } from './fixtures/fake-hub-client';
import { settle } from './fixtures/fake-packages-client';

// The Hub panel's search (hub-plan H11, the signed-off mock with the user's
// decisions of 2026-10-12): the debounced field and the stale-request
// abort, the four filters with the hub's facet counts, the sort control
// (decision 1), every package listed with its badges (decisions 2 and 3),
// the pager and the empty, loading and offline states.

/** Timers the test fires by hand. */
class ManualTimers implements HubTimers {
  pending: { callback: () => void; ms: number }[] = [];
  set(callback: () => void, ms: number): unknown {
    const entry = { callback, ms };
    this.pending.push(entry);
    return entry;
  }
  clear(handle: unknown): void {
    this.pending = this.pending.filter((entry) => entry !== handle);
  }
  fire(): void {
    for (const entry of this.pending.splice(0)) {
      entry.callback();
    }
  }
}

const views: HubSearchView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.innerHTML = '';
});

function mount(client = new FakeHubClient(), engine = { engine: '0.0.46', sdk: 1 }) {
  const timers = new ManualTimers();
  const state = new HubPanelState(client, timers);
  const onOpen = vi.fn();
  const view = new HubSearchView({ state, onOpen, hubHost: () => 'localhost:8787', engine: () => engine });
  views.push(view);
  document.body.appendChild(view.el);
  const $ = <T extends Element = HTMLElement>(selector: string) => view.el.querySelector<T>(selector);
  const $$ = (selector: string) => [...view.el.querySelectorAll<HTMLElement>(selector)];
  const row = (name: string) => $(`[data-package="${name}"]`)!;
  const marks = (name: string) => [...row(name).querySelectorAll<HTMLElement>('[data-mark]')].map((m) => m.textContent);
  const lastParams = () => client.search.mock.calls.at(-1)![0];
  return { client, timers, state, view, onOpen, $, $$, row, marks, lastParams };
}

describe('the search request', () => {
  it('debounces typing, searches at once on Enter, and sends the hub its names (no compatible filter)', async () => {
    const h = mount();
    h.state.search();
    await settle();
    expect(h.client.search).toHaveBeenCalledTimes(1);
    const input = h.$<HTMLInputElement>('[data-ref="query"]')!;
    for (const value of ['s', 'st', 'standoff']) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    expect(h.timers.pending).toHaveLength(1);
    expect(h.timers.pending[0].ms).toBe(HubPanelState.DEBOUNCE_MS);
    expect(h.client.search).toHaveBeenCalledTimes(1);
    h.timers.fire();
    await settle();
    expect(h.client.search).toHaveBeenCalledTimes(2);
    expect(h.lastParams()).toEqual({ q: 'standoff', contents: [], keyword: [], units: [], license: [], sort: null, order: null, page: 1 });
    input.value = 'standoff hole';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(h.timers.pending).toHaveLength(0);
    expect(h.lastParams().q).toBe('standoff hole');
    // The bridge's query string: repeated keys, defaults left out, and never compatible.
    expect(HttpHubClient.searchQuery({ q: ' @acme  gear ', contents: ['features', 'parts'], keyword: ['pcb'], units: [], license: ['MIT'], sort: 'installs', order: 'asc', page: 2 }))
      .toBe('q=%40acme++gear&contents=features&contents=parts&keyword=pcb&license=MIT&sort=installs&order=asc&page=2');
    expect(HttpHubClient.searchQuery(HubPanelState.EMPTY)).toBe('');
  });

  it('aborts the search in flight when a newer one starts, and drops a stale answer', async () => {
    const h = mount();
    h.client.holdSearches = true;
    h.state.search();
    await settle();
    const first = h.client.search.mock.calls[0][1] as AbortSignal;
    h.state.toggle('contents', 'parts');
    await settle();
    expect(first.aborted).toBe(true);
    const second = h.client.search.mock.calls[1][1] as AbortSignal;
    expect(second.aborted).toBe(false);
    h.client.releaseSearches();
    await settle();
    expect(h.state.snapshot.mode).toBe('results');
    expect(h.state.snapshot.params.contents).toEqual(['parts']);
  });

  it('turns each filter value on and off from its dropdown, with the facet counts, and goes back to page 1', async () => {
    const h = mount();
    h.state.setPage(3);
    await settle();
    expect(h.lastParams().page).toBe(3);
    h.$('[data-filter="contents"]')!.click();
    const menu = h.$('[data-menu="contents"]')!;
    expect([...menu.querySelectorAll<HTMLElement>('[data-value]')].map((v) => `${v.dataset.value}:${v.querySelector('[data-ref="count"]')!.textContent}`))
      .toEqual(['features:9', 'parts:7', 'assemblies:3']);
    menu.querySelector<HTMLInputElement>('[data-value="assemblies"] input')!.dispatchEvent(new Event('change'));
    await settle();
    expect(h.lastParams()).toMatchObject({ contents: ['assemblies'], page: 1 });
    for (const [filter, value] of [['keyword', 'pcb'], ['units', 'metric'], ['license', 'MIT']] as const) {
      h.$(`[data-filter="${filter}"]`)!.click();
      h.$(`[data-menu="${filter}"] [data-value="${value}"] input`)!.dispatchEvent(new Event('change'));
      await settle();
    }
    expect(h.lastParams()).toMatchObject({ contents: ['assemblies'], keyword: ['pcb'], units: ['metric'], license: ['MIT'] });
    // The license dropdown (still open: a value doesn't close it) names each with the picker's label.
    expect(h.$('[data-menu="license"] [data-value="Apache-2.0"]')!.textContent).toContain('Apache License 2.0');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.$('[data-menu]')).toBeNull();
    // The chips name the filters and take one off; Clear filters takes them all.
    expect(h.$$('[data-chip]').map((c) => c.dataset.chip)).toEqual(['contents:assemblies', 'keyword:pcb', 'units:metric', 'license:MIT']);
    h.$('[data-chip="units:metric"] button')!.click();
    await settle();
    expect(h.lastParams().units).toEqual([]);
    h.$('[data-ref="clear-filters"]')!.click();
    await settle();
    expect(h.lastParams()).toMatchObject({ contents: [], keyword: [], units: [], license: [] });
    // No compatibility toggle and no Creates/Modifies chips (decision 2; H9's design).
    expect(h.view.el.textContent).not.toMatch(/Works with my FluidCAD|Creates|Modifies/);
  });
});

describe('the sort control (decision 1)', () => {
  it('names the sort, flips its direction with the icon, and disables the icon on Best match', async () => {
    const h = mount();
    h.state.search();
    await settle();
    expect(h.$('[data-ref="sort-name"]')!.textContent!.trim()).toBe('Most installed');
    const order = () => h.$<HTMLButtonElement>('[data-ref="order"]')!;
    expect(order().disabled).toBe(false);
    expect(order().dataset.order).toBe('desc');
    order().click();
    await settle();
    expect(h.lastParams()).toMatchObject({ sort: 'installs', order: 'asc' });
    h.client.answer = { ...h.client.answer, request: { ...h.client.answer.request, order: 'asc' } };
    h.state.search();
    await settle();
    expect(order().dataset.order).toBe('asc');
    expect(order().title).toMatch(/^Least installed first/);
    // Picking a sort takes its own direction.
    h.$('[data-ref="sort-name"]')!.click();
    expect(h.$$('[data-menu="sort"] [data-sort]').map((o) => o.dataset.sort)).toEqual(['installs', 'likes', 'updated', 'newest']);
    h.$('[data-menu="sort"] [data-sort="newest"]')!.click();
    await settle();
    expect(h.lastParams()).toMatchObject({ sort: 'newest', order: null });

    // With words, Best match is offered, and has one direction.
    h.client.answer = FakeHubClient.answer([FakeHubClient.row()], { request: { ...FakeHubClient.answer([]).request, q: 'standoff', words: ['standoff'], sort: 'relevance', order: 'desc' } });
    h.state.setSort(null);
    h.state.setQuery('standoff');
    h.state.search();
    await settle();
    expect(h.$('[data-ref="sort-name"]')!.textContent!.trim()).toBe('Best match');
    expect(order().disabled).toBe(true);
    h.$('[data-ref="sort-name"]')!.click();
    expect(h.$$('[data-menu="sort"] [data-sort]').map((o) => o.dataset.sort)).toEqual(['relevance', 'installs', 'likes', 'updated', 'newest']);
    const calls = h.client.search.mock.calls.length;
    h.state.flipOrder();
    await settle();
    expect(h.client.search.mock.calls.length).toBe(calls);
  });

  it('follows the hub: Best match only with words, else Most installed', () => {
    expect(HubPanelState.hasWords('@acme')).toBe(false);
    expect(HubPanelState.hasWords('@acme standoff')).toBe(true);
    expect(HubPanelState.hasWords('@mira/gears')).toBe(true);
    const state = new HubPanelState(new FakeHubClient(), new ManualTimers());
    expect(state.effectiveSort()).toBe('installs');
    state.setQuery('gear');
    expect(state.effectiveSort()).toBe('relevance');
    expect(state.effectiveOrder()).toBe('desc');
  });
});

describe('the rows', () => {
  it('lists every package with its card through the media proxy, chips and +N, contents, likes, installs and license', async () => {
    const h = mount();
    h.state.search();
    await settle();
    const row = h.row('@acme/feature-tests');
    expect(row.querySelector<HTMLImageElement>('[data-ref="thumb"] img')!.getAttribute('src')).toBe('api/hub/media/@acme/feature-tests/card-1');
    expect([...row.querySelectorAll('[data-ref="chip"]')].map((c) => c.textContent)).toEqual(['Bolt circle', 'Boss', 'Fastener hole']);
    expect(row.querySelector('[data-ref="more"]')!.textContent).toBe('+2');
    expect(row.textContent).toContain('5 features · 5 parts · 1 assembly');
    expect(row.querySelector('[data-ref="license"]')!.textContent).toBe('MIT');
    row.click();
    expect(h.onOpen).toHaveBeenCalledWith('@acme/feature-tests');
  });

  it('marks installed, pinned, update available, Deprecated with its message, and why an incompatible one cannot run (decision 3)', async () => {
    const client = new FakeHubClient();
    client.answer = FakeHubClient.answer([
      FakeHubClient.row({ local: { installed: ['0.1.0'], pinned: '0.1.0', updateAvailable: '0.1.1' } }),
      FakeHubClient.row({ fullName: '@acme/same', local: { installed: ['0.1.1'], pinned: '0.1.1', updateAvailable: null } }),
      FakeHubClient.row({ fullName: '@crank/inline-four', compatible: false, minEngine: '0.0.47', sdkVersion: 1 }),
      FakeHubClient.row({ fullName: '@pivot/hinges', compatible: false, minEngine: '0.1.0', sdkVersion: 2 }),
      FakeHubClient.row({ fullName: '@old/brackets', compatible: false, minEngine: '0.0.45', sdkVersion: 0 }),
      FakeHubClient.row({ fullName: '@odd/thing', compatible: false, minEngine: '0.0.45', sdkVersion: 1 }),
      FakeHubClient.row({ fullName: '@amberlight/lantern', deprecated: 'Use @amberlight/lamp' }),
      FakeHubClient.row({ fullName: '@fine/ok', compatible: null, minEngine: '0.9.0' }),
    ]);
    const h = mount(client);
    h.state.search();
    await settle();
    expect(h.marks('@acme/feature-tests')).toEqual(['installed 0.1.0', 'pinned 0.1.0', 'update available']);
    expect(h.marks('@acme/same')).toEqual(['installed', 'pinned']);
    expect(h.marks('@crank/inline-four')).toEqual(['Requires FluidCAD 0.0.47+']);
    expect(h.marks('@pivot/hinges')).toEqual(['Requires FluidCAD 0.1.0+']);
    expect(h.marks('@old/brackets')).toEqual(['Made for an older FluidCAD']);
    expect(h.marks('@odd/thing')).toEqual(['Not compatible with this FluidCAD']);
    expect(h.marks('@amberlight/lantern')).toEqual(['Deprecated']);
    expect(h.row('@amberlight/lantern').querySelector<HTMLElement>('.tooltip')!.dataset.tip).toBe('Use @amberlight/lamp');
    expect(h.row('@crank/inline-four').querySelector<HTMLElement>('.tooltip')!.dataset.tip).toBe('This is FluidCAD 0.0.46.');
    // Only when the hub says it can't run it.
    expect(h.marks('@fine/ok')).toEqual([]);
    expect(h.view.el.textContent).not.toMatch(/feature SDK/);
  });

  it('pages with Previous and Next, and says the hub lists the first 1,000 on the last reachable page', async () => {
    const client = new FakeHubClient();
    client.answer = FakeHubClient.answer(Array.from({ length: 20 }, (_, i) => FakeHubClient.row({ fullName: `@p/n${i}` })), { total: 134 });
    const h = mount(client);
    h.state.search();
    await settle();
    expect(h.$('[data-ref="range"]')!.textContent).toBe('1–20 of 134');
    expect(h.$<HTMLButtonElement>('[data-ref="previous"]')!.disabled).toBe(true);
    h.$('[data-ref="next"]')!.click();
    await settle();
    expect(h.lastParams().page).toBe(2);
    expect(h.$('[data-ref="range"]')!.textContent).toBe('21–40 of 134');
    client.answer = FakeHubClient.answer(Array.from({ length: 20 }, (_, i) => FakeHubClient.row({ fullName: `@p/m${i}` })), { total: 1000, capped: true });
    h.state.setPage(50);
    await settle();
    expect(h.$('[data-ref="range"]')!.textContent).toBe('981–1,000 of 1,000+');
    expect(h.$<HTMLButtonElement>('[data-ref="next"]')!.disabled).toBe(true);
    expect(h.$('[data-ref="capped-note"]')!.textContent).toBe('The hub lists the first 1,000 matches. Add a word or a filter to see others.');
    expect(h.$('[data-ref="total"]')!.textContent).toBe('1,000+ packages');
  });
});

describe('the states', () => {
  it('shows the skeleton while loading, then an empty answer for words, and for filters with a way out', async () => {
    const client = new FakeHubClient();
    client.holdSearches = true;
    const h = mount(client);
    h.state.search();
    await settle();
    expect(h.$('[data-ref="loading"]')).not.toBeNull();
    client.answer = FakeHubClient.answer([]);
    client.releaseSearches();
    await settle();
    client.holdSearches = false;
    h.state.setQuery('zzzz');
    h.state.search();
    await settle();
    expect(h.$('[data-state="empty"]')!.textContent).toContain('No packages match “zzzz”');
    h.state.setQuery('');
    h.state.toggle('units', 'imperial');
    await settle();
    h.state.toggle('contents', 'assemblies');
    await settle();
    expect(h.$('[data-state="empty"]')!.textContent).toContain('Nothing matches all of these filters');
    h.$('[data-ref="remove-last"]')!.click();
    await settle();
    expect(h.lastParams()).toMatchObject({ units: [], contents: ['assemblies'] });
  });

  it('shows the hub unreachable with Try again, and searches again from it', async () => {
    const client = new FakeHubClient();
    client.searchRefusal = { status: 503, error: "Couldn't reach http://localhost:8787: ECONNREFUSED", code: 'hub-unreachable' };
    const h = mount(client);
    h.state.search();
    await settle();
    expect(h.state.snapshot.mode).toBe('offline');
    expect(h.$('[data-state="offline"]')!.textContent).toContain('Couldn’t reach localhost:8787');
    client.searchRefusal = null;
    h.$('[data-ref="retry"]')!.click();
    await settle();
    expect(h.state.snapshot.mode).toBe('results');
    expect(h.row('@acme/feature-tests')).not.toBeNull();
  });

  it('keeps the rows on screen during a quiet refresh (the marks after an install)', async () => {
    const client = new FakeHubClient();
    const h = mount(client);
    h.state.search();
    await settle();
    client.holdSearches = true;
    h.state.refresh();
    await settle();
    expect(h.$('[data-ref="loading"]')).toBeNull();
    expect(h.row('@acme/feature-tests')).not.toBeNull();
    client.releaseSearches();
    await settle();
  });
});

describe('HubText', () => {
  it('says why by the CLI rule, compares versions by semver, and counts and dates', () => {
    expect(HubText.incompatibility({ minEngine: '0.1.0-beta.1', sdkVersion: 1 }, '0.0.46', 1).text).toBe('Requires FluidCAD 0.1.0-beta.1+');
    expect(HubText.incompatibility({ minEngine: '0.0.46', sdkVersion: 2 }, '0.0.46', 1).kind).toBe('unknown');
    expect(HubText.incompatibility({ minEngine: '0.0.40', sdkVersion: 1 }, '0.1.0', 2).text).toBe('Made for an older FluidCAD');
    expect(HubText.compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(HubText.compareVersions('0.0.10', '0.0.9')).toBe(1);
    expect(HubText.compareVersions('1.0.0-beta.11', '1.0.0-beta.2')).toBe(1);
    expect(HubText.compareVersions('soon', '1.0.0')).toBe(0);
    const now = Date.parse('2026-10-12T12:00:00Z');
    expect(HubText.ago('2026-10-12T08:00:00Z', now)).toBe('today');
    expect(HubText.ago('2026-10-11T08:00:00Z', now)).toBe('1 day ago');
    expect(HubText.ago('2026-07-12T08:00:00Z', now)).toBe('3 months ago');
    expect(HubText.contents({ features: 1, parts: 0, assemblies: 2 })).toBe('1 feature · 2 assemblies');
    expect(HubText.license('LicenseRef-Proprietary')).toBe('All rights reserved');
  });
});

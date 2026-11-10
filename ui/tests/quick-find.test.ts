// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FeatureButton } from '../src/interactive/create-feature/feature-button';
import { CONSTRAINT_SHORTCUTS } from '../src/interactive/solved-constraint-toolbar/solved-constraint-toolbar';
import { TOOL_SHORTCUTS } from '../src/ui/sketch-toolbar';
import { HubPanelState } from '../src/ui/hub/hub-panel-state';
import { Navbar } from '../src/ui/navbar/navbar';
import { QuickFindPins } from '../src/ui/quick-find/quick-find-pins';
import { QuickFindPopover } from '../src/ui/quick-find/quick-find-popover';
import { ToolIndex, isShownOnBar, toolIndex, type QuickFindTool } from '../src/ui/quick-find/tool-index';
import { FakeHubClient } from './fixtures/fake-hub-client';

// Quick Find on its own: the index the toolbars register into and its
// ranking, the pins and their cap, and the popover — what it shows before
// and after typing, the keyboard, the pins, and the hub under an empty
// result. The toolbars' registrations are checked through a FeatureButton.

beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
  (globalThis as any).cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});

const mounted: QuickFindPopover[] = [];

afterEach(() => {
  for (const popover of mounted.splice(0)) {
    popover.destroy();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** A tool in the index: available unless told otherwise, counting its runs. */
function fake(index: ToolIndex, id: string, label: string, extra: Partial<QuickFindTool> & { available?: boolean; disabled?: boolean } = {}) {
  const runs = vi.fn();
  const state = { available: extra.available ?? true, disabled: extra.disabled ?? false, active: false };
  const tool: QuickFindTool = {
    id,
    label,
    tip: extra.tip ?? label,
    bench: extra.bench ?? 'Part',
    iconSrc: extra.iconSrc ?? `icons/${label.toLowerCase()}.png`,
    shortcut: extra.shortcut,
    keywords: extra.keywords,
    isAvailable: () => state.available,
    isDisabled: () => state.disabled,
    disabledReason: () => (state.disabled ? `${label} is busy` : null),
    isActive: () => state.active,
    run: runs,
  };
  const off = index.register(tool);
  return { tool, runs, state, off };
}

/** The part bench as the popover sees it: eight tools, six of them the default pins. */
function partBench(index: ToolIndex) {
  return {
    sketch: fake(index, 'part:sketch', 'Sketch', { tip: 'Sketch on a face or a plane' }),
    extrude: fake(index, 'part:extrude', 'Extrude', { tip: 'Extrude a sketch' }),
    revolve: fake(index, 'part:revolve', 'Revolve', { tip: 'Revolve a sketch' }),
    hole: fake(index, 'part:hole', 'Hole', { tip: 'Hole' }),
    fillet: fake(index, 'part:fillet', 'Fillet', { tip: 'Fillet edges' }),
    shell: fake(index, 'part:shell', 'Shell', { tip: 'Shell' }),
    chamfer: fake(index, 'part:chamfer', 'Chamfer', { tip: 'Chamfer edges' }),
    repeat: fake(index, 'part:repeat', 'Repeat', { tip: 'Repeat a feature' }),
    line: fake(index, 'sketch:line', 'Line', { bench: 'Sketch', available: false, shortcut: 'l' }),
  };
}

function mount(opts: { hub?: FakeHubClient | null; pins?: QuickFindPins; index?: ToolIndex } = {}) {
  const index = opts.index ?? new ToolIndex();
  const tools = partBench(index);
  const pins = opts.pins ?? new QuickFindPins(index);
  const saved = vi.fn();
  pins.onChange = saved;
  const openPackage = vi.fn();
  const searchHub = vi.fn();
  const hubClient = opts.hub === undefined ? new FakeHubClient() : opts.hub;
  const hub = hubClient ? { state: new HubPanelState(hubClient), openPackage, searchHub } : null;
  const popover = new QuickFindPopover({ index, pins, hub });
  mounted.push(popover);
  const el = () => document.querySelector<HTMLElement>('[data-role="quick-find"]');
  const input = () => el()!.querySelector<HTMLInputElement>('[data-ref="query"]')!;
  const type = (text: string) => {
    input().value = text;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (k: string) => input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const tiles = () => [...el()!.querySelectorAll<HTMLElement>('[data-ref="pinned"] [data-tool]')].map(t => t.dataset.tool);
  const rows = () => [...el()!.querySelectorAll<HTMLElement>('[role="option"][data-tool]')].map(r => r.dataset.tool);
  return { index, tools, pins, saved, popover, hub, hubClient, openPackage, searchHub, el, input, type, key, tiles, rows };
}

describe('ToolIndex', () => {
  it('lists only the tools on the bar and ranks a name before a synonym before a tooltip word', () => {
    const index = new ToolIndex();
    const { line } = partBench(index);
    expect(index.available().map(t => t.id)).not.toContain('sketch:line');
    line.state.available = true;
    expect(index.available().map(t => t.id)).toContain('sketch:line');

    // "fil" is Fillet's start; "round" is only a synonym of Fillet (and of Circle, not on this bench).
    expect(index.search('fil').map(m => m.tool.id)).toEqual(['part:fillet']);
    expect(index.search('round').map(m => m.tool.id)).toEqual(['part:fillet']);
    // "pattern" finds Repeat by what other tools call it.
    expect(index.search('pattern').map(m => m.tool.id)).toEqual(['part:repeat']);
    // A tooltip word: "edges" is in Fillet's and Chamfer's tips, in name order.
    expect(index.search('edges').map(m => m.tool.id)).toEqual(['part:chamfer', 'part:fillet']);
    // "sketch" names the Sketch tool first, then the tools whose tip mentions one.
    const sketch = index.search('sketch').map(m => m.tool.id);
    expect(sketch[0]).toBe('part:sketch');
    expect(sketch).toContain('part:extrude');
    // Letters in order reach a name ("shl" for Shell) once nothing else does; nonsense finds nothing.
    expect(index.search('shl').map(m => m.tool.id)).toEqual(['part:shell']);
    expect(index.search('zzq')).toEqual([]);
    expect(index.search('   ')).toEqual([]);
  });

  it('a second registration under an id replaces the first, and only the live entry can remove it', () => {
    const index = new ToolIndex();
    const a = fake(index, 'part:x', 'Old');
    const b = fake(index, 'part:x', 'New');
    expect(index.get('part:x')!.label).toBe('New');
    a.off();
    expect(index.get('part:x')!.label).toBe('New');
    b.off();
    expect(index.get('part:x')).toBeNull();
  });
});

describe('QuickFindPins', () => {
  it('starts from the defaults, shows the six that are on the bar, and refuses a seventh', () => {
    const index = new ToolIndex();
    partBench(index);
    const pins = new QuickFindPins(index);
    const saved = vi.fn();
    pins.onChange = saved;
    expect(pins.shown().map(t => t.id)).toEqual(['part:sketch', 'part:extrude', 'part:revolve', 'part:hole', 'part:fillet', 'part:shell']);
    expect(pins.full).toBe(true);
    expect(pins.pin('part:chamfer')).toBe(false);
    expect(saved).not.toHaveBeenCalled();

    pins.unpin('part:shell');
    expect(saved).toHaveBeenLastCalledWith(expect.not.arrayContaining(['part:shell']));
    expect(pins.full).toBe(false);
    expect(pins.pin('part:chamfer')).toBe(true);
    expect(pins.shown().map(t => t.id)).toEqual(['part:sketch', 'part:extrude', 'part:revolve', 'part:hole', 'part:fillet', 'part:chamfer']);
    // The stored list keeps the other benches' defaults: a sketch pin still shows in a sketch.
    expect(saved).toHaveBeenLastCalledWith(expect.arrayContaining(['sketch:line', 'part:chamfer']));
  });

  it('pins put back exactly to the defaults store as null; loaded pins replace the defaults without a save', () => {
    const index = new ToolIndex();
    partBench(index);
    const pins = new QuickFindPins(index);
    const saved = vi.fn();
    pins.onChange = saved;
    pins.unpin('part:shell');
    expect(saved).toHaveBeenLastCalledWith(expect.any(Array));
    // Pinning Shell again appends it at the end: a different order, not the defaults.
    pins.pin('part:shell');
    expect(saved).toHaveBeenLastCalledWith(expect.any(Array));
    pins.set(null);
    expect(pins.list).toEqual(QuickFindPins.DEFAULTS);
    pins.set(['part:hole']);
    expect(pins.shown().map(t => t.id)).toEqual(['part:hole']);
    expect(saved).toHaveBeenCalledTimes(2);
  });
});

describe('QuickFindPopover', () => {
  it('opens where the pointer is with the pinned tiles, and a tile runs its tool and closes it', () => {
    const { popover, tools, el, tiles, input } = mount();
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 300 }));
    popover.toggleAtPointer();
    expect(popover.isOpen).toBe(true);
    expect(el()!.style.left).toBe('380px');
    expect(el()!.style.top).toBe('280px');
    expect(document.activeElement).toBe(input());
    expect(tiles()).toEqual(['part:sketch', 'part:extrude', 'part:revolve', 'part:hole', 'part:fillet', 'part:shell']);
    expect(el()!.querySelector('[data-ref="pinned-heading"]')!.textContent).toBe('Pinned6 / 6');

    el()!.querySelector<HTMLElement>('[data-tool="part:hole"] [role="option"]')!.click();
    expect(tools.hole.runs).toHaveBeenCalledTimes(1);
    expect(popover.isOpen).toBe(false);
    expect(el()).toBeNull();
  });

  it('a pinned tool that is off the bar is not a tile; a disabled one is greyed and will not run', () => {
    const { popover, tools, el, tiles } = mount();
    tools.revolve.state.available = false;
    tools.sketch.state.disabled = true;
    popover.openAt({ x: 100, y: 100 });
    expect(tiles()).toEqual(['part:sketch', 'part:extrude', 'part:hole', 'part:fillet', 'part:shell']);
    const sketch = el()!.querySelector<HTMLElement>('[data-tool="part:sketch"] [role="option"]')!;
    expect(sketch.getAttribute('aria-disabled')).toBe('true');
    expect(sketch.title).toBe('Sketch is busy');
    sketch.click();
    expect(tools.sketch.runs).not.toHaveBeenCalled();
    expect(popover.isOpen).toBe(true);
  });

  it('typing lists the matching tools with their chord; Enter runs the first, the arrows move the highlight', () => {
    const { popover, tools, type, key, rows, el, input } = mount();
    tools.line.state.available = true;
    popover.openAt({ x: 100, y: 100 });
    type('l');
    // Line (its name), then the tools whose words start with l — none here but Line.
    expect(rows()[0]).toBe('sketch:line');
    const line = el()!.querySelector<HTMLElement>('[data-tool="sketch:line"]')!;
    expect(line.querySelector('kbd')!.textContent).toBe('l');
    expect(line.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(line.id);

    type('e');
    // Extrude by its initial, then every name with an e in it, by name; Sketch is the ninth and off the list.
    expect(rows()).toEqual(['part:extrude', 'part:chamfer', 'part:fillet', 'part:hole', 'sketch:line', 'part:repeat', 'part:revolve', 'part:shell']);
    key('ArrowDown');
    expect(el()!.querySelector('[data-tool="part:chamfer"]')!.getAttribute('aria-selected')).toBe('true');
    key('ArrowUp');
    expect(el()!.querySelector('[data-tool="part:extrude"]')!.getAttribute('aria-selected')).toBe('true');
    key('ArrowUp');
    expect(el()!.querySelector('[data-tool="part:shell"]')!.getAttribute('aria-selected')).toBe('true');
    key('Enter');
    expect(tools.shell.runs).toHaveBeenCalledTimes(1);
    expect(popover.isOpen).toBe(false);
  });

  it('Escape, a press outside and a wheel outside close it; a press inside does not', () => {
    const { popover, key, el } = mount();
    popover.openAt({ x: 100, y: 100 });
    key('Escape');
    expect(popover.isOpen).toBe(false);

    popover.openAt({ x: 100, y: 100 });
    el()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(popover.isOpen).toBe(true);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(popover.isOpen).toBe(false);

    popover.openAt({ x: 100, y: 100 });
    document.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    expect(popover.isOpen).toBe(false);
  });

  it('the pin on a row pins the tool (saving the list) and is refused while six already show here', () => {
    const { popover, pins, saved, type, el, tiles } = mount();
    popover.openAt({ x: 100, y: 100 });
    type('cham');
    const pin = () => el()!.querySelector<HTMLButtonElement>('[data-tool="part:chamfer"] [data-ref="pin"]')!;
    expect(pin().disabled).toBe(true);
    expect(pin().title).toContain('Unpin one');

    type('shell');
    const unpin = el()!.querySelector<HTMLButtonElement>('[data-tool="part:shell"] [data-ref="pin"]')!;
    expect(unpin.dataset.pinned).toBe('true');
    unpin.click();
    expect(pins.isPinned('part:shell')).toBe(false);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(popover.isOpen).toBe(true);

    type('cham');
    expect(pin().disabled).toBe(false);
    pin().click();
    expect(pins.isPinned('part:chamfer')).toBe(true);
    expect(pin().dataset.pinned).toBe('true');
    type('');
    expect(tiles()).toEqual(['part:sketch', 'part:extrude', 'part:revolve', 'part:hole', 'part:fillet', 'part:chamfer']);
    // Unpinning from a tile too.
    el()!.querySelector<HTMLButtonElement>('[data-tool="part:chamfer"] [data-ref="pin"]')!.click();
    expect(tiles()).toHaveLength(5);
  });

  it('with no tool matching it asks the hub once typing pauses, lists up to three packages and a way to the full search', async () => {
    vi.useFakeTimers();
    const { popover, hubClient, type, el, openPackage, searchHub, key } = mount();
    hubClient!.answer = FakeHubClient.answer([
      FakeHubClient.row({ fullName: '@acme/gears' }),
      FakeHubClient.row({ fullName: '@acme/more-gears', cardImageUrl: null }),
      FakeHubClient.row({ fullName: '@bolt/gearbox' }),
      FakeHubClient.row({ fullName: '@bolt/spur' }),
    ]);
    hubClient!.answer.request.q = 'gear';
    popover.openAt({ x: 100, y: 100 });
    type('gear');
    expect(el()!.querySelector('[data-ref="no-match"]')!.textContent).toBe('No tool matches “gear”.');
    expect(el()!.querySelectorAll('[data-ref="hub-loading"]')).toHaveLength(2);
    expect(hubClient!.search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HubPanelState.DEBOUNCE_MS + 10);
    expect(hubClient!.search).toHaveBeenCalledTimes(1);
    expect(hubClient!.search.mock.calls[0][0].q).toBe('gear');
    const packages = [...el()!.querySelectorAll<HTMLElement>('[data-package]')].map(r => r.dataset.package);
    expect(packages).toEqual(['@acme/gears', '@acme/more-gears', '@bolt/gearbox']);
    expect(el()!.querySelector('[data-ref="search-hub"]')!.textContent).toContain('Search the hub for “gear”');

    // Enter on the first suggestion opens its detail in the Hub panel.
    key('Enter');
    expect(openPackage).toHaveBeenCalledWith('@acme/gears');
    expect(popover.isOpen).toBe(false);

    popover.openAt({ x: 100, y: 100 });
    type('gear');
    await vi.advanceTimersByTimeAsync(HubPanelState.DEBOUNCE_MS + 10);
    el()!.querySelector<HTMLElement>('[data-ref="search-hub"]')!.click();
    expect(searchHub).toHaveBeenCalledWith('gear');
    expect(popover.isOpen).toBe(false);
  });

  it('a hub lookup is dropped once the words match a tool after all, and never starts without a hub', async () => {
    vi.useFakeTimers();
    const { popover, hubClient, type, el } = mount();
    popover.openAt({ x: 100, y: 100 });
    type('fillx');
    type('fill');
    await vi.advanceTimersByTimeAsync(HubPanelState.DEBOUNCE_MS + 10);
    expect(hubClient!.search).not.toHaveBeenCalled();
    expect(el()!.querySelector('[data-ref="hub"]')).toBeNull();
    popover.close();

    const bare = mount({ hub: null });
    bare.popover.openAt({ x: 100, y: 100 });
    bare.type('zzq');
    expect(bare.el()!.querySelector('[data-ref="no-match"]')).not.toBeNull();
    expect(bare.el()!.querySelector('[data-ref="hub"]')).toBeNull();
  });

  it('says when the hub does not answer, and when it has nothing either', async () => {
    vi.useFakeTimers();
    const { popover, hubClient, type, el } = mount();
    hubClient!.searchRefusal = { status: 503, error: 'The hub doesn’t answer.', code: 'hub-unreachable' };
    popover.openAt({ x: 100, y: 100 });
    type('zzq');
    await vi.advanceTimersByTimeAsync(HubPanelState.DEBOUNCE_MS + 10);
    expect(el()!.querySelector('[data-ref="hub-notice"]')!.textContent).toBe('The hub doesn’t answer.');

    hubClient!.searchRefusal = null;
    hubClient!.answer = FakeHubClient.answer([]);
    hubClient!.answer.request.q = 'zzq';
    popover.close();
    popover.openAt({ x: 100, y: 100 });
    type('zzq');
    await vi.advanceTimersByTimeAsync(HubPanelState.DEBOUNCE_MS + 10);
    expect(el()!.querySelector('[data-ref="hub-notice"]')!.textContent).toBe('Nothing on the hub either.');
  });

  it('stays inside the window and opens under a button', () => {
    const { popover, el } = mount();
    popover.openAt({ x: window.innerWidth - 10, y: 10 });
    expect(parseInt(el()!.style.left, 10)).toBeLessThanOrEqual(window.innerWidth - 300 - 8);
    expect(el()!.style.top).toBe('8px');
    popover.close();

    const button = document.createElement('button');
    document.body.appendChild(button);
    button.getBoundingClientRect = () => ({ left: 500, right: 540, top: 50, bottom: 90, width: 40, height: 40 } as DOMRect);
    popover.toggleBelow(button);
    expect(el()!.style.top).toBe('96px');
    popover.toggleBelow(button);
    expect(popover.isOpen).toBe(false);
  });
});

describe('the toolbars in the index', () => {
  it('a FeatureButton lists itself under part:<tool>, follows the bar, and leaves with remove()', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const navbar = new Navbar(container);
    const group = navbar.addGroup('create', { immune: true });
    const button = new FeatureButton(group, { icon: 'icons/extrude.png', label: 'Extrude', tip: 'Extrude a sketch', ariaLabel: 'Extrude' });
    const clicks = vi.fn();
    button.onClick = clicks;
    const entry = toolIndex.get('part:extrude')!;
    expect(entry).not.toBeNull();
    expect(entry.tip).toBe('Extrude a sketch');
    expect(entry.isAvailable()).toBe(true);
    entry.run();
    expect(clicks).toHaveBeenCalledTimes(1);

    button.setSketchHidden(true);
    expect(entry.isAvailable()).toBe(false);
    button.setSketchHidden(false);
    navbar.setGroupVisible('create', false);
    expect(entry.isAvailable()).toBe(false);
    navbar.setGroupVisible('create', true);
    button.setVisible(false);
    expect(entry.isAvailable()).toBe(false);
    button.setVisible(true);
    button.setDisabled(true);
    expect(entry.isDisabled!()).toBe(true);
    button.setActive(true);
    expect(entry.isActive!()).toBe(true);

    button.remove();
    expect(toolIndex.get('part:extrude')).toBeNull();
    expect(isShownOnBar(group)).toBe(true);
  });

  it('s is free for Quick Find: Symmetric is sy, and no sketch chord is the bare letter', () => {
    expect(CONSTRAINT_SHORTCUTS.symmetric).toBe('sy');
    const chords = [...Object.values(TOOL_SHORTCUTS), ...Object.values(CONSTRAINT_SHORTCUTS), 'g', 'n'];
    expect(chords).not.toContain('s');
    expect(new Set(chords).size).toBe(chords.length);
  });
});

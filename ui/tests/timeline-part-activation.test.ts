// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import { ActivePartTracker } from '../src/interactive/active-part-tracker';
import { setActivePartLocationProvider } from '../src/helpers/scene-utils';
import type { EngineClient } from '../src/engine-client';
import type { SceneObjectRender } from '../src/types';

// Part rows toggle the timeline's active part: a click on an inactive part
// activates it, a click on the active one steps out to the file's top level
// — the part stays selected (the Parameters panel's part) but its row turns
// plain like every other inactive part. The pause gestures point the active
// part at the paused row's scope.

Element.prototype.scrollIntoView = vi.fn();

const FILE = 'a.fluid.js';

function part(id: string, line: number): SceneObjectRender {
  return {
    id, name: `part-${line}`, type: 'part', isContainer: true,
    sceneShapes: [], ownShapes: [], visible: true,
    sourceLocation: { filePath: FILE, line, column: 1 },
  } as unknown as SceneObjectRender;
}

function feature(id: string, line: number, parentId?: string): SceneObjectRender {
  return {
    id, name: 'extrude', type: 'extrude', sceneShapes: [], ownShapes: [], visible: true, parentId,
    sourceLocation: { filePath: FILE, line, column: 1 },
  } as unknown as SceneObjectRender;
}

/** Parts A and B, then a top-level feature written after both — timeline order. */
const SCENE = [
  part('A', 1), feature('a1', 2, 'A'),
  part('B', 10), feature('b1', 11, 'B'),
  feature('top', 20),
];

const rowObject = (id: string) => SCENE.find(o => o.id === id)!;

/** Only the active part row is highlighted: blue cube, tint, blue bold name and the dot. */
const ACTIVE_LOOK = { icon: 'icons/box-blue.png', tinted: true, blueText: true, bold: true, dot: true };
/** Every other part row is plain, with the white cube. */
const PLAIN_LOOK = { icon: 'icons/box.png', tinted: false, blueText: false, bold: false, dot: false };

/** The panel wired to a real tracker the way main.ts wires it. */
function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = { gotoSource: vi.fn(), addBreakpoint: vi.fn() };
  const client = { savePreference: vi.fn(), rollback: vi.fn(), editor } as unknown as EngineClient;
  const timeline = new TimelinePanel(
    container, client,
    () => undefined, () => undefined, () => undefined, () => false, () => undefined, () => 1, () => undefined,
  );
  const tracker = new ActivePartTracker();
  setActivePartLocationProvider(() => tracker.location);
  const setActivePart = vi.fn((row: SceneObjectRender | null) =>
    row === null ? tracker.deactivate() : tracker.activate(row));
  timeline.setActivePart = setActivePart;
  timeline.isPartRowActive = (obj) => tracker.isActive(obj);
  tracker.sync(SCENE);
  timeline.update(SCENE, SCENE.length - 1);

  const row = (id: string) => container.querySelector<HTMLElement>(`[data-index="${SCENE.findIndex(o => o.id === id)}"]`)!;
  const click = (id: string, detail = 1) => row(id).dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  const hasDot = (id: string) => row(id).querySelector('[title^="Active part"]') !== null;
  const look = (id: string) => ({
    icon: row(id).querySelector('img')!.getAttribute('src'),
    tinted: row(id).classList.contains('bg-primary/10'),
    blueText: row(id).classList.contains('text-primary'),
    bold: row(id).querySelector('.truncate')!.classList.contains('font-semibold'),
    dot: hasDot(id),
  });
  const isSelected = (id: string) => tracker.isSelected(rowObject(id));
  return { container, editor, tracker, setActivePart, row, click, hasDot, look, isSelected };
}

afterEach(() => {
  setActivePartLocationProvider(() => null);
  document.body.innerHTML = '';
});

describe('timeline part activation', () => {
  it('opens on the last part, selected and active', () => {
    const h = mount();
    expect(h.row('B').dataset.activePart).toBe('true');
    expect(h.isSelected('B')).toBe(true);
    expect(h.look('B')).toEqual(ACTIVE_LOOK);
    expect(h.look('A')).toEqual(PLAIN_LOOK);
  });

  it('steps out to the top level on a click on the active part, leaving its row plain', () => {
    const h = mount();
    h.click('B');
    expect(h.setActivePart).toHaveBeenLastCalledWith(null);
    expect(h.tracker.location).toBeNull();
    expect(h.row('B').dataset.activePart).toBe('false');
    // Still the Parameters panel's part, but it reads like any inactive part.
    expect(h.isSelected('B')).toBe(true);
    expect(h.look('B')).toEqual(PLAIN_LOOK);
    expect(h.look('A')).toEqual(PLAIN_LOOK);
    // Part rows still follow their source instead of rolling back.
    expect(h.editor.gotoSource).toHaveBeenCalled();
  });

  it('steps back in on a click on the part stepped out of', () => {
    const h = mount();
    h.click('B');
    h.click('B');
    expect(h.tracker.isActive(rowObject('B'))).toBe(true);
    expect(h.look('B')).toEqual(ACTIVE_LOOK);
  });

  it('activates another part from the top level', () => {
    const h = mount();
    h.click('B');
    h.click('A');
    expect(h.look('A')).toEqual(ACTIVE_LOOK);
    expect(h.isSelected('B')).toBe(false);
    expect(h.look('B')).toEqual(PLAIN_LOOK);
  });

  it('ends a double-click inside the part, from either state', () => {
    const h = mount();
    // Inactive part: the first click activates, the second must not step out.
    h.click('A', 1);
    h.click('A', 2);
    expect(h.hasDot('A')).toBe(true);
    // Active part: the first click steps out, the second steps back in.
    h.click('A', 1);
    h.click('A', 2);
    expect(h.hasDot('A')).toBe(true);
  });

  it('steps out when a pause lands on a top-level row', () => {
    const h = mount();
    h.row('top').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(h.tracker.location).toBeNull();
    expect(h.isSelected('B')).toBe(true);
    expect(h.look('B')).toEqual(PLAIN_LOOK);
    expect(h.editor.addBreakpoint).toHaveBeenCalledWith(rowObject('top').sourceLocation);
  });

  it('activates the part around a paused row inside it', () => {
    const h = mount();
    h.click('B');
    h.row('a1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(h.hasDot('A')).toBe(true);
    expect(h.tracker.location?.line).toBe(1);
  });

  it('leaves the scope alone when the pause is placed on a part row', () => {
    const h = mount();
    h.row('A').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    h.container.querySelector<HTMLElement>('[data-action="rollback"]')!.click();
    expect(h.setActivePart).not.toHaveBeenCalled();
    expect(h.hasDot('B')).toBe(true);
    expect(h.editor.addBreakpoint).toHaveBeenCalledWith(rowObject('A').sourceLocation);
  });
});

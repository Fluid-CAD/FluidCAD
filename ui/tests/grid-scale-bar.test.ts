// @vitest-environment jsdom

// The grid scale-bar chip as a control: what its edit field accepts, what a
// commit writes to the shared settings store (and persists), and how the
// padlock and the Settings dialog stay in agreement — both read and write
// `viewerSettings`, so a lock toggled from either side shows on the other.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GridScaleBar } from '../src/ui/grid-scale-bar';
import { lockGridPitch, parseGridPitch, setGridLocked } from '../src/grid/grid-pitch';
import { viewerSettings } from '../src/scene/viewer-settings';
import { sceneUnit } from '../src/units/scene-unit';
import { DEFAULT_GRID_FIXED_SPACING } from '../src/grid/grid-spacing';

describe('parseGridPitch', () => {
  it('reads decimals, fractions and mixed numbers', () => {
    expect(parseGridPitch('0.125')).toBe(0.125);
    expect(parseGridPitch('1/8')).toBe(0.125);
    expect(parseGridPitch(' 3 / 16 ')).toBe(3 / 16);
    expect(parseGridPitch('1 1/2')).toBe(1.5);
    expect(parseGridPitch('.5')).toBe(0.5);
    expect(parseGridPitch('10')).toBe(10);
  });

  it('tolerates a trailing unit word', () => {
    expect(parseGridPitch('1/8 in')).toBe(0.125);
    expect(parseGridPitch('2.5mm')).toBe(2.5);
    expect(parseGridPitch('1/2"')).toBe(0.5);
  });

  it('refuses zero, negatives, and non-numbers', () => {
    expect(parseGridPitch('0')).toBeNull();
    expect(parseGridPitch('-1')).toBeNull();
    expect(parseGridPitch('1/0')).toBeNull();
    expect(parseGridPitch('abc')).toBeNull();
    expect(parseGridPitch('')).toBeNull();
    expect(parseGridPitch('1/8/2')).toBeNull();
  });
});

function resetStores(): void {
  viewerSettings.update({
    gridAdaptive: true,
    gridFixedSpacing: { ...DEFAULT_GRID_FIXED_SPACING },
    showGrid: true,
  });
  sceneUnit.set('mm');
}

describe('grid pitch commit / lock semantics', () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it('lockGridPitch pins the current unit, engages the lock, and persists both', () => {
    const save = vi.fn();
    sceneUnit.set('in');
    lockGridPitch('in', 0.125, save);
    expect(viewerSettings.current.gridAdaptive).toBe(false);
    expect(viewerSettings.current.gridFixedSpacing.in).toBe(0.125);
    // Other units keep their pitch.
    expect(viewerSettings.current.gridFixedSpacing.mm).toBe(DEFAULT_GRID_FIXED_SPACING.mm);
    expect(save).toHaveBeenCalledWith('gridFixedSpacing', expect.objectContaining({ in: 0.125, mm: 10 }));
    expect(save).toHaveBeenCalledWith('gridAdaptive', false);
  });

  it('setGridLocked toggles adaptive and persists it', () => {
    const save = vi.fn();
    setGridLocked(true, save);
    expect(viewerSettings.current.gridAdaptive).toBe(false);
    expect(save).toHaveBeenLastCalledWith('gridAdaptive', false);
    setGridLocked(false, save);
    expect(viewerSettings.current.gridAdaptive).toBe(true);
    expect(save).toHaveBeenLastCalledWith('gridAdaptive', true);
  });
});

describe('GridScaleBar', () => {
  let container: HTMLElement;
  let save: ReturnType<typeof vi.fn>;
  let bar: GridScaleBar;

  const value = () => container.querySelector<HTMLButtonElement>('[data-ref="grid-scale-value"]')!;
  const input = () => container.querySelector<HTMLInputElement>('[data-ref="grid-scale-input"]')!;
  const lock = () => container.querySelector<HTMLButtonElement>('[data-ref="grid-scale-lock"]')!;
  const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
    container = document.createElement('div');
    document.body.appendChild(container);
    save = vi.fn();
    bar = new GridScaleBar(container, save as any);
    bar.update({ minor: 5, major: 50 }, true);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    // vitest runs this repo with `isolate: false`: the stores are shared
    // module singletons, so leave them as the next file expects them.
    resetStores();
  });

  it('shows the adaptive pitch with an open padlock', () => {
    expect(bar.text).toBe('5 mm');
    expect(bar.locked).toBe(false);
    expect(lock().getAttribute('aria-pressed')).toBe('false');
    expect(lock().title).toBe('Lock grid spacing (fixed pitch)');
  });

  it('click → field pre-filled with the pitch; Enter commits, locks, re-pitches, persists', () => {
    sceneUnit.set('in');
    bar.update({ minor: 0.25, major: 1 }, true);
    value().click();
    expect(input().classList.contains('hidden')).toBe(false);
    expect(input().value).toBe('1/4');

    input().value = '1/8';
    key(input(), 'Enter');

    expect(bar.locked).toBe(true);
    expect(viewerSettings.current.gridFixedSpacing.in).toBe(0.125);
    expect(bar.text).toBe('1/8 in');
    expect(lock().getAttribute('aria-pressed')).toBe('true');
    expect(lock().title).toBe('Unlock (adaptive to zoom)');
    expect(save).toHaveBeenCalledWith('gridFixedSpacing', expect.objectContaining({ in: 0.125 }));
    expect(save).toHaveBeenCalledWith('gridAdaptive', false);
    expect(input().classList.contains('hidden')).toBe(true);
  });

  it('Escape cancels without touching the store', () => {
    value().click();
    input().value = '2';
    key(input(), 'Escape');
    expect(input().classList.contains('hidden')).toBe(true);
    expect(viewerSettings.current.gridAdaptive).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(bar.text).toBe('5 mm');
  });

  it('blur commits', () => {
    value().click();
    input().value = '0.5';
    input().dispatchEvent(new FocusEvent('blur'));
    expect(bar.locked).toBe(true);
    expect(viewerSettings.current.gridFixedSpacing.mm).toBe(0.5);
    expect(bar.text).toBe('0.5 mm');
  });

  it('an invalid value flashes red and keeps the old pitch', () => {
    value().click();
    input().value = '-3';
    key(input(), 'Enter');
    expect(input().classList.contains('ring-error')).toBe(true);
    expect(input().classList.contains('hidden')).toBe(false);
    expect(viewerSettings.current.gridAdaptive).toBe(true);
    expect(viewerSettings.current.gridFixedSpacing.mm).toBe(10);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(700);
    expect(input().classList.contains('ring-error')).toBe(false);
    // A blur with junk in the field just closes it.
    input().dispatchEvent(new FocusEvent('blur'));
    expect(input().classList.contains('hidden')).toBe(true);
    expect(bar.text).toBe('5 mm');
  });

  it('the padlock toggles adaptive and shows the fixed pitch while locked', () => {
    lock().click();
    expect(viewerSettings.current.gridAdaptive).toBe(false);
    expect(save).toHaveBeenLastCalledWith('gridAdaptive', false);
    // Locked: the store's pitch for the unit, not the ladder's last pick.
    expect(bar.text).toBe('10 mm');
    lock().click();
    expect(viewerSettings.current.gridAdaptive).toBe(true);
    expect(bar.text).toBe('5 mm');
  });

  it('follows a lock toggled elsewhere (the Settings dialog writes the same store)', () => {
    viewerSettings.update({ gridAdaptive: false, gridFixedSpacing: { ...viewerSettings.current.gridFixedSpacing, mm: 2 } });
    expect(bar.locked).toBe(true);
    expect(bar.text).toBe('2 mm');
    expect(lock().getAttribute('aria-pressed')).toBe('true');
  });

  it('relabels when the document unit changes', () => {
    viewerSettings.update({ gridAdaptive: false });
    sceneUnit.set('in');
    expect(bar.text).toBe('1/2 in');
  });
});

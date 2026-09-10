// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved through node:path, not `new URL(...)`: under jsdom the global URL is
// jsdom's own, which fileURLToPath cannot convert.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
import {
  CONSTRAINT_SHORTCUTS,
  SolvedConstraintToolbar,
} from '../src/interactive/solved-constraint-toolbar/solved-constraint-toolbar';
import { TOOL_SHORTCUTS } from '../src/ui/sketch-toolbar';
import { ShortcutManager } from '../src/ui/shortcut-manager';

const LABELS = [
  'Coincident', 'Horizontal', 'Vertical', 'Parallel', 'Perpendicular', 'Tangent',
  'Equal', 'Concentric', 'Collinear', 'Midpoint', 'Symmetric', 'Fix',
  'Dimension', 'Angle', 'Delete constraint',
];

/** The buttons are icon-only; `aria-label` carries the constraint's name. */
function buttonsOf(container: HTMLElement): Map<string, HTMLButtonElement> {
  const result = new Map<string, HTMLButtonElement>();
  for (const btn of container.querySelectorAll('button')) {
    result.set(btn.getAttribute('aria-label')!, btn);
  }
  return result;
}

describe('SolvedConstraintToolbar view', () => {
  it('points every button at artwork that exists on disk', () => {
    // Icon-only buttons: a typo'd or missing PNG silently degrades to the
    // generic fallback cube, which says nothing about the constraint.
    const container = document.createElement('div');
    new SolvedConstraintToolbar(container);

    const srcs = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src')!);
    expect(srcs).toHaveLength(LABELS.length);
    for (const src of srcs) {
      expect(existsSync(join(PUBLIC_DIR, src))).toBe(true);
    }
  });

  it('names every button, in bar order', () => {
    const container = document.createElement('div');
    new SolvedConstraintToolbar(container);
    expect([...buttonsOf(container).keys()]).toEqual(LABELS);
  });

  it('desaturates the icon of a disabled button and restores it when legal', () => {
    const container = document.createElement('div');
    const view = new SolvedConstraintToolbar(container);
    const iconOf = (label: string) => buttonsOf(container).get(label)!.querySelector('img')!;

    view.setOptions([]);
    expect(iconOf('Parallel').className).toContain('grayscale');

    view.setOptions([{ id: 'parallel', enabled: true }]);
    expect(iconOf('Parallel').className).not.toContain('grayscale');
  });

  it('keeps the icon of an armed dimension button at full colour', () => {
    const container = document.createElement('div');
    const view = new SolvedConstraintToolbar(container);
    view.setOptions([]);
    view.setDimensionArmed(true);

    const btn = buttonsOf(container).get('Dimension')!;
    expect(btn.disabled).toBe(false);
    expect(btn.querySelector('img')!.className).not.toContain('grayscale');
  });
});

describe('SolvedConstraintToolbar shortcuts', () => {
  // Every sketch-mode chord lands on ONE ShortcutManager (the drawing tools,
  // the guide latch, the view key, the constraint bar), and registering the
  // same chord twice throws — so this is the collision check for the two
  // vocabularies.
  it('share the sketch-mode manager with the drawing tools without colliding', () => {
    const m = new ShortcutManager();
    for (const keys of Object.values(TOOL_SHORTCUTS)) {
      m.register(keys, () => {});
    }
    m.register('g', () => {});
    m.register('n', () => {});
    for (const keys of Object.values(CONSTRAINT_SHORTCUTS)) {
      expect(() => m.register(keys, () => {})).not.toThrow();
    }
    m.destroy();
  });

  it('show the chord in every button tooltip', () => {
    const container = document.createElement('div');
    new SolvedConstraintToolbar(container);
    for (const [id, keys] of Object.entries(CONSTRAINT_SHORTCUTS)) {
      const label = id[0].toUpperCase() + id.slice(1);
      const btn = buttonsOf(container).get(label)!;
      const kbd = btn.parentElement!.querySelector('kbd');
      expect(kbd?.textContent, id).toBe(keys);
    }
  });
});

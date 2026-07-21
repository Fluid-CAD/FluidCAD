import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UNIQUE_TYPE_ICONS, resolveIconName, DEFAULT_ICON_SRC } from '../src/ui/object-icons';

const iconPath = (name: string) =>
  fileURLToPath(new URL(`../public/icons/${name}.png`, import.meta.url));

describe('resolveIconName', () => {
  it('falls back to the plain type when the unique type has no entry', () => {
    // Most features never need a mapping: an additive wrap reports
    // uniqueType 'wrap' / type 'wrap', and axis-from-sketch reports
    // uniqueType 'axis-from-sketch' / type 'axis'.
    expect(resolveIconName('wrap', 'wrap')).toBe('wrap');
    expect(resolveIconName('axis-from-sketch', 'axis')).toBe('axis');
  });

  it('shows the wrap icon for both wrap ops', () => {
    // Wrap.getType() is 'wrap' in every op, so a deboss reaches the wrap
    // artwork through the plain-type fallback and needs no mapping of its own.
    expect(resolveIconName('wrap-remove', 'wrap')).toBe('wrap');
  });

  it('leaves an extrude-driven cut on the cut icon', () => {
    expect(resolveIconName('cut', 'cut')).toBe('cut');
    expect(resolveIconName('cut-symmetric', 'cut')).toBe('cut');
  });

  it('falls back to solid when neither type is known', () => {
    expect(resolveIconName(undefined, undefined)).toBe('solid');
  });
});

describe('icon artwork', () => {
  const entries: [string, string][] = Object.entries(UNIQUE_TYPE_ICONS);

  it.each(entries)('%s resolves to real artwork', (_uniqueType, icon) => {
    expect(existsSync(iconPath(icon))).toBe(true);
  });

  it('has the default icon on disk, since it backstops every missing PNG', () => {
    expect(existsSync(fileURLToPath(new URL(`../public${DEFAULT_ICON_SRC}`, import.meta.url)))).toBe(true);
  });
});

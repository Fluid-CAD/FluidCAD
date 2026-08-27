// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { TimelinePanel } from '../src/ui/timeline-panel';
import { ParamsPanel } from '../src/ui/params-panel';
import type { EngineClient } from '../src/engine-client';
import type { UIParamDefinition } from '../src/types';

// The docked part-design column stacks three sections: History, Shapes and —
// since parameters moved off the scene-settings column — Parameters. Shapes
// and Parameters are the pair that browses the whole model rather than steps
// of it, so at most one of them is ever open; History is the column's subject
// and stays independent of both.

function stubClient() {
  return {
    resetParams: vi.fn(),
    setParam: vi.fn(),
    savePreference: vi.fn(),
  } as unknown as EngineClient;
}

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const client = stubClient();
  const params = new ParamsPanel(null, client);
  const timeline = new TimelinePanel(
    container,
    client,
    () => undefined,
    () => undefined,
    () => undefined,
    () => false,
    () => undefined,
    () => 1,
    () => undefined,
  );
  timeline.attachParams(params);
  const headers = () => [...container.querySelectorAll<HTMLElement>('.panel-bg.cursor-pointer')];
  return {
    container,
    timeline,
    params,
    client,
    headers,
    header: (title: string) => headers().find((h) => h.textContent?.includes(title))!,
    titles: () => headers().map((h) => h.querySelector('span:nth-child(2)')?.textContent?.trim()),
    /** Whether the body that follows this header is on screen. */
    isOpen: (title: string) => {
      const body = headers().find((h) => h.textContent?.includes(title))!.nextElementSibling!;
      return !body.classList.contains('hidden');
    },
  };
}

const PARAM: UIParamDefinition = {
  label: 'width', controlType: 'number', defaultValue: 10, currentValue: 10,
} as UIParamDefinition;

describe('docked panel column', () => {
  it('stacks Parameters under Shapes', () => {
    const h = mount();
    expect(h.titles()).toEqual(['History', 'Shapes', 'Parameters']);
  });

  it('opens Shapes and leaves the joining Parameters closed', () => {
    const h = mount();
    expect(h.isOpen('Shapes')).toBe(true);
    expect(h.isOpen('Parameters')).toBe(false);
  });

  it('closes Shapes when Parameters opens, and back again', () => {
    const h = mount();
    h.header('Parameters').click();
    expect(h.isOpen('Parameters')).toBe(true);
    expect(h.isOpen('Shapes')).toBe(false);

    h.header('Shapes').click();
    expect(h.isOpen('Shapes')).toBe(true);
    expect(h.isOpen('Parameters')).toBe(false);
  });

  it('leaves History open across the pair, and closes on its own', () => {
    const h = mount();
    h.header('Parameters').click();
    expect(h.isOpen('History')).toBe(true);

    h.header('History').click();
    expect(h.isOpen('History')).toBe(false);
    expect(h.isOpen('Parameters')).toBe(true);
  });

  it('caps Shapes and Parameters at half the scene, reserving nothing', () => {
    const h = mount();
    for (const title of ['Shapes', 'Parameters']) {
      const body = h.header(title).nextElementSibling as HTMLElement;
      expect(body.className).toContain('max-h-[var(--fluidcad-half-scene)]');
      // No floor and no grow: an empty section takes no height, so the one
      // below it sits flush under it instead of hanging over the scene.
      expect(body.className).not.toMatch(/\bmin-h-\[|\bflex-1\b/);
      expect(body.className).toContain('shrink-0');
    }
  });

  it('runs the header buttons without collapsing the section', () => {
    const h = mount();
    h.header('Parameters').click();
    h.header('Parameters').querySelector<HTMLButtonElement>('[data-reset-params]')!.click();
    expect(h.client.resetParams).toHaveBeenCalledTimes(1);
    expect(h.isOpen('Parameters')).toBe(true);
  });

  it('offers no Add button without an editor-backed host', () => {
    const h = mount();
    expect(h.header('Parameters').querySelector('[data-add-param]')).toBeNull();
  });

  it('carries the parameters across a rail rebuild', () => {
    const h = mount();
    h.params.update([PARAM]);
    h.header('Parameters').click();
    expect(h.header('Parameters').nextElementSibling!.textContent).toContain('width');

    // Part → assembly → part: the column goes, the panel that owns the
    // parameters does not.
    h.timeline.dispose();
    const rebuilt = new TimelinePanel(
      h.container, h.client,
      () => undefined, () => undefined, () => undefined, () => false,
      () => undefined, () => 1, () => undefined,
    );
    rebuilt.attachParams(h.params);
    expect(h.titles()).toEqual(['History', 'Shapes', 'Parameters']);
    expect(h.header('Parameters').nextElementSibling!.textContent).toContain('width');
  });
});

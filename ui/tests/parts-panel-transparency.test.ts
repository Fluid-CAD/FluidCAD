// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PartsPanel, type TransparencyHandlers } from '../src/ui/parts-panel';
import type { RenderedInstance } from '../src/types';

// The parts panel's Transparency…: offered on the open file's own inserts
// only, its slider previews while it moves, commits once per release, and
// closing it (×, Escape, a click elsewhere, the row going away) always
// settles the preview.

function instance(id: string, extra: Partial<RenderedInstance> = {}): RenderedInstance {
  return {
    instanceId: id,
    partId: `part-${id}`,
    partName: id,
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
    owner: '',
    name: id,
    visible: true,
    sourceLocation: { filePath: '/a.assembly.js', line: 3, column: 0 },
    ...extra,
  };
}

function mount(instances: RenderedInstance[], withHandlers = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const handlers = {
    open: vi.fn((_id: string) => 0.25),
    preview: vi.fn(),
    commit: vi.fn(),
    end: vi.fn(),
  } satisfies TransparencyHandlers;
  const panel = new PartsPanel(
    container,
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    undefined,
    undefined,
    withHandlers ? { transparency: handlers } : {},
  );
  panel.update(instances);
  return { container, panel, handlers };
}

function openMenu(container: HTMLElement, instanceId: string): void {
  const row = container.querySelector<HTMLElement>(`[data-instance-id="${instanceId}"]`)!;
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
}

function openPopover(container: HTMLElement, instanceId: string): HTMLInputElement {
  openMenu(container, instanceId);
  container.querySelector<HTMLButtonElement>('[data-action="transparency"]')!.click();
  return container.querySelector<HTMLInputElement>(`[data-transparency-popover="${instanceId}"] [data-ref="slider"]`)!;
}

describe('parts panel Transparency…', () => {
  it('is offered on the open file\'s own inserts, not on sub-assembly members or replicas', () => {
    const { container } = mount([
      instance('own'),
      instance('member', { owner: 'asm-0' }),
      instance('copy', { replica: { of: 'own', statement: 'rep-0', row: 0 } }),
    ]);
    openMenu(container, 'own');
    expect(container.querySelector('[data-action="transparency"]')).not.toBeNull();
    openMenu(container, 'member');
    expect(container.querySelector('[data-action="transparency"]')).toBeNull();
    openMenu(container, 'copy');
    expect(container.querySelector('[data-action="transparency"]')).toBeNull();
  });

  it('is absent without handlers', () => {
    const { container } = mount([instance('own')], false);
    openMenu(container, 'own');
    expect(container.querySelector('[data-action="transparency"]')).toBeNull();
  });

  it('reads how much of the part shows: an opaque part opens at 100%', () => {
    const { container, handlers } = mount([instance('a')]);
    handlers.open.mockReturnValueOnce(0);
    const slider = openPopover(container, 'a');
    expect(slider.value).toBe('100');
    expect(container.querySelector('[data-ref="value"]')!.textContent).toBe('100%');
  });

  it('starts at what the part shows, previews on input and commits on release', () => {
    const { container, handlers } = mount([instance('a')]);
    const slider = openPopover(container, 'a');
    expect(handlers.open).toHaveBeenCalledWith('a');
    // `.transparent(0.25)` shows 75% of the part.
    expect(slider.value).toBe('75');

    // Lowering the slider fades the part: 40% showing is `.transparent(0.6)`.
    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(handlers.preview).toHaveBeenLastCalledWith('a', 0.6);
    expect(handlers.commit).not.toHaveBeenCalled();
    expect(container.querySelector('[data-ref="value"]')!.textContent).toBe('40%');

    slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(handlers.commit).toHaveBeenCalledTimes(1);
    expect(handlers.commit).toHaveBeenLastCalledWith('a', 0.6);

    // Back up to 100% is opaque again — the commit drops the call.
    slider.value = '100';
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(handlers.commit).toHaveBeenLastCalledWith('a', 0);
  });

  it('closing by ×, Escape or the row going away settles the preview once', () => {
    const { container, panel, handlers } = mount([instance('a'), instance('b')]);

    openPopover(container, 'a');
    container.querySelector<HTMLButtonElement>('[data-transparency-popover="a"] [data-action="close"]')!.click();
    expect(handlers.end).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-transparency-popover]')).toBeNull();

    openPopover(container, 'a');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(handlers.end).toHaveBeenCalledTimes(2);

    openPopover(container, 'b');
    panel.update([instance('a')]);
    expect(handlers.end).toHaveBeenCalledTimes(3);
    expect(handlers.end).toHaveBeenLastCalledWith('b');
    expect(container.querySelector('[data-transparency-popover]')).toBeNull();
  });

  it('survives a re-render of its own row', () => {
    const { container, panel, handlers } = mount([instance('a')]);
    openPopover(container, 'a');
    panel.update([instance('a', { transparency: 0.4 })]);
    expect(container.querySelector('[data-transparency-popover="a"]')).not.toBeNull();
    expect(handlers.end).not.toHaveBeenCalled();
    panel.dispose();
    expect(handlers.end).toHaveBeenCalledTimes(1);
  });
});

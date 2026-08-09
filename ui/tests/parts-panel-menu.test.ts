// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PartsPanel } from '../src/ui/parts-panel';
import type { RenderedInstance } from '../src/types';

// The parts-panel row menu: reachable by right-click as well as the ⋮ button,
// every item carrying its icon, and "Toggle grounded" asking for the OPPOSITE
// of the row's current ground (it used to always request `ground: true`, so a
// grounded instance could never be released).

function instance(id: string, grounded: boolean): RenderedInstance {
  return {
    instanceId: id,
    partId: `part-${id}`,
    partName: id,
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded,
    name: id,
    visible: true,
    sourceLocation: { filePath: '/a.assembly.js', line: 3, column: 0 },
  };
}

type Harness = {
  container: HTMLElement;
  panel: PartsPanel;
  setGround: ReturnType<typeof vi.fn>;
  showInSource: ReturnType<typeof vi.fn>;
};

function mount(instances: RenderedInstance[]): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const setGround = vi.fn();
  const showInSource = vi.fn();
  const panel = new PartsPanel(
    container,
    () => {},
    () => {},
    showInSource,
    setGround,
    () => {},
    () => {},
  );
  panel.update(instances);
  return { container, panel, setGround, showInSource };
}

function rightClickRow(container: HTMLElement, instanceId: string): void {
  const row = container.querySelector<HTMLElement>(`[data-instance-id="${instanceId}"]`)!;
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
}

describe('parts panel row menu', () => {
  it('opens on right-click with an icon on every item', () => {
    const { container } = mount([instance('a', false)]);
    expect(container.querySelector('[data-action="set-ground"]')).toBeNull();

    rightClickRow(container, 'a');

    const actions = ['show-in-source', 'set-ground', 'rename', 'delete'];
    for (const action of actions) {
      const item = container.querySelector<HTMLElement>(`[data-action="${action}"]`);
      expect(item, action).not.toBeNull();
      expect(item!.querySelector('svg'), `${action} icon`).not.toBeNull();
    }
    expect(container.querySelector('[data-action="set-ground"]')!.textContent)
      .toContain('Toggle grounded');
  });

  it('right-click still routes actions to the row it was opened on', () => {
    const { container, showInSource } = mount([instance('a', false), instance('b', false)]);
    rightClickRow(container, 'b');
    container.querySelector<HTMLElement>('[data-action="show-in-source"]')!.click();
    expect(showInSource).toHaveBeenCalledWith('b');
  });

  it('toggles ground both ways', () => {
    const { container, setGround } = mount([instance('free', false), instance('anchored', true)]);

    rightClickRow(container, 'free');
    container.querySelector<HTMLElement>('[data-action="set-ground"]')!.click();
    expect(setGround).toHaveBeenLastCalledWith('free', true);

    rightClickRow(container, 'anchored');
    container.querySelector<HTMLElement>('[data-action="set-ground"]')!.click();
    expect(setGround).toHaveBeenLastCalledWith('anchored', false);
  });

  it('opens from the ⋮ button too', () => {
    const { container, setGround } = mount([instance('a', true)]);
    container.querySelector<HTMLElement>('[data-dots="a"]')!.click();
    container.querySelector<HTMLElement>('[data-action="set-ground"]')!.click();
    expect(setGround).toHaveBeenCalledWith('a', false);
  });
});

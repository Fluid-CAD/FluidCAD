// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PartsPanel } from '../src/ui/parts-panel';
import type { RenderedInstance, SerializedAssemblyOccurrence } from '../src/types';

// The parts-panel row menu: reachable by right-click as well as the ⋮ button,
// every item carrying its icon, and "Toggle grounded" asking for the OPPOSITE
// of the row's current ground (it used to always request `ground: true`, so a
// grounded instance could never be released).

function instance(id: string, grounded: boolean, owner = ''): RenderedInstance {
  return {
    instanceId: id,
    partId: `part-${id}`,
    partName: id,
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded,
    owner,
    name: id,
    visible: true,
    sourceLocation: { filePath: '/a.assembly.js', line: 3, column: 0 },
  };
}

function occurrence(id: string, grounded = false): SerializedAssemblyOccurrence {
  return {
    occurrenceId: id,
    assemblyName: `sub-${id}`,
    name: `sub-${id}`,
    parentPath: '',
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded,
    groundConnected: grounded,
    sourceLocation: { filePath: '/a.assembly.js', line: 9, column: 0 },
  };
}

type Harness = {
  container: HTMLElement;
  panel: PartsPanel;
  setGround: ReturnType<typeof vi.fn>;
  showInSource: ReturnType<typeof vi.fn>;
  occSetGround: ReturnType<typeof vi.fn>;
  occDelete: ReturnType<typeof vi.fn>;
};

function mount(
  instances: RenderedInstance[],
  occurrences: SerializedAssemblyOccurrence[] = [],
): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const setGround = vi.fn();
  const showInSource = vi.fn();
  const occSetGround = vi.fn();
  const occDelete = vi.fn();
  const panel = new PartsPanel(
    container,
    () => {},
    () => {},
    showInSource,
    setGround,
    () => {},
    () => {},
    {
      onShowInSource: () => {},
      onSetGround: occSetGround,
      onRename: () => {},
      onDelete: occDelete,
    },
  );
  panel.update(instances, occurrences);
  return { container, panel, setGround, showInSource, occSetGround, occDelete };
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

describe('parts panel occurrence groups', () => {
  it('groups occurrence-owned instances under a header row', () => {
    const { container } = mount(
      [instance('inst-0', true), instance('asm-0/inst-0', false, 'asm-0'), instance('asm-0/inst-1', false, 'asm-0')],
      [occurrence('asm-0')],
    );
    const header = container.querySelector<HTMLElement>('[data-occurrence-id="asm-0"]');
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain('sub-asm-0');
    // Members render indented below the header; the root instance stays plain.
    expect(container.querySelectorAll('[data-instance-id]')).toHaveLength(3);
  });

  it('does not match asm-1 members into asm-10 (path-segment prefix)', () => {
    const { container } = mount(
      [instance('asm-1/inst-0', false, 'asm-1'), instance('asm-10/inst-0', false, 'asm-10')],
      [occurrence('asm-1'), occurrence('asm-10')],
    );
    const headers = [...container.querySelectorAll<HTMLElement>('[data-occurrence-id]')];
    expect(headers.map(h => h.dataset.occurrenceId)).toEqual(['asm-1', 'asm-10']);
  });

  it('collapses and expands a group on header click', () => {
    const { container } = mount(
      [instance('asm-0/inst-0', false, 'asm-0')],
      [occurrence('asm-0')],
    );
    const clickHeader = () => container
      .querySelector<HTMLElement>('[data-occurrence-id="asm-0"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(container.querySelector('[data-instance-id="asm-0/inst-0"]')).not.toBeNull();
    clickHeader();
    expect(container.querySelector('[data-instance-id="asm-0/inst-0"]')).toBeNull();
    clickHeader();
    expect(container.querySelector('[data-instance-id="asm-0/inst-0"]')).not.toBeNull();
  });

  it('offers ONLY Show in source on occurrence-owned instance rows', () => {
    const { container } = mount(
      [instance('asm-0/inst-0', false, 'asm-0')],
      [occurrence('asm-0')],
    );
    rightClickRow(container, 'asm-0/inst-0');
    expect(container.querySelector('[data-action="show-in-source"]')).not.toBeNull();
    expect(container.querySelector('[data-action="set-ground"]')).toBeNull();
    expect(container.querySelector('[data-action="rename"]')).toBeNull();
    expect(container.querySelector('[data-action="delete"]')).toBeNull();
  });

  it('routes the header menu to occurrence handlers, toggling ground both ways', () => {
    const { container, occSetGround, occDelete } = mount(
      [instance('asm-0/inst-0', false, 'asm-0')],
      [occurrence('asm-0', true)],
    );
    container.querySelector<HTMLElement>('[data-group-dots="asm-0"]')!.click();
    container.querySelector<HTMLElement>('[data-action="set-ground"]')!.click();
    expect(occSetGround).toHaveBeenCalledWith('asm-0', false);

    container.querySelector<HTMLElement>('[data-group-dots="asm-0"]')!.click();
    container.querySelector<HTMLElement>('[data-action="delete"]')!.click();
    expect(occDelete).toHaveBeenCalledWith('asm-0');
  });
});

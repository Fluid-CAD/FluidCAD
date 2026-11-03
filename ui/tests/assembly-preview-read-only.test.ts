// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewScene } from '../src/interactive/generated/preview-scene';
import { AssemblyPoseWrites } from '../src/scene/assembly-pose-writes';
import { ConnectorsPanel } from '../src/ui/connectors-panel';
import { JointsPanel } from '../src/ui/joints-panel';
import { PartsPanel } from '../src/ui/parts-panel';
import type { RenderedInstance, SerializedAssemblyMate, SerializedAssemblyOccurrence } from '../src/types';

// While an assembly preview is on screen (generators S6) nothing on the page
// writes a row: the parts, joints and connectors panels go read-only and a
// moved part's pose is never written back — and engine-owned parts (a
// generator's, G8) are read-only always, their occurrence header keeping
// its actions. (The Insert dialog's generated tiles are in
// instance-params-dialogs.test.ts, beside its api mock.)

afterEach(() => {
  previewScene.set(null);
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function instance(id: string, extra: Partial<RenderedInstance> = {}): RenderedInstance {
  return {
    instanceId: id, partId: `part-${id}`, partName: id, name: id, visible: true, grounded: false, owner: '',
    position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
    sourceLocation: { filePath: '/ws/shop.assembly.js', line: 3, column: 0 },
    ...extra,
  };
}

function occurrence(id: string, extra: Partial<SerializedAssemblyOccurrence> = {}): SerializedAssemblyOccurrence {
  return {
    occurrenceId: id, assemblyName: 'Crate', name: 'crate1', parentPath: '', grounded: false, groundConnected: false,
    position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
    sourceLocation: { filePath: '/ws/shop.assembly.js', line: 5, column: 0 },
    ...extra,
  };
}

function mountParts(instances: RenderedInstance[], occurrences: SerializedAssemblyOccurrence[] = []) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editParams = vi.fn();
  const panel = new PartsPanel(
    container, () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
    { onShowInSource: () => {}, onSetGround: () => {}, onRename: () => {}, onDelete: () => {} },
    editParams,
    { transparency: { open: () => 0, preview: () => {}, commit: () => {}, end: () => {} } },
  );
  panel.update(instances, occurrences);
  const actions = () => [...container.querySelectorAll<HTMLElement>('[data-action]')].map(item => item.dataset.action);
  const openRow = (id: string) => container.querySelector<HTMLElement>(`[data-instance-id="${id}"]`)!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const openHeader = (id: string) => container.querySelector<HTMLElement>(`[data-occurrence-id="${id}"]`)!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  return { container, panel, editParams, actions, openRow, openHeader };
}

describe('the parts panel during a preview, and engine-owned rows', () => {
  it('goes read-only while a preview shows (no ⋮, no menu) and comes back after', () => {
    const { container, panel, actions, openRow } = mountParts([instance('a')], [occurrence('asm-0')]);
    expect(container.querySelectorAll('[data-dots], [data-group-dots]')).toHaveLength(2);
    panel.setReadOnly(true);
    expect(panel.isReadOnly).toBe(true);
    expect(container.querySelectorAll('[data-dots], [data-group-dots]')).toHaveLength(0);
    openRow('a');
    expect(actions()).toEqual([]);
    panel.setReadOnly(false);
    expect(container.querySelectorAll('[data-dots], [data-group-dots]')).toHaveLength(2);
    openRow('a');
    expect(actions()).toContain('delete');
  });

  it('closes an open menu when it goes read-only', () => {
    const { panel, actions, openRow } = mountParts([instance('a')]);
    openRow('a');
    expect(actions().length).toBeGreaterThan(0);
    panel.setReadOnly(true);
    expect(actions()).toEqual([]);
  });

  it('offers only Show in source on an engine-owned part, at the root or under its generated occurrence', () => {
    const { actions, openRow, openHeader } = mountParts([
      instance('base', { generatedBy: { definition: 'crate', type: 'base' } }),
      instance('asm-0/inst-0', { owner: 'asm-0', generatedBy: { definition: 'crate', type: 'lid' } }),
    ], [occurrence('asm-0', { generated: { definition: 'crate', values: { width: 40 } } })]);
    openRow('base');
    expect(actions()).toEqual(['show-in-source']);
    openRow('asm-0/inst-0');
    expect(actions()).toEqual(['show-in-source']);
    // The occurrence header — the user's own insert — keeps its actions.
    openHeader('asm-0');
    expect(actions()).toEqual(['show-in-source', 'edit-params', 'set-ground', 'rename', 'delete']);
  });

  it('offers Edit parameters on a generated occurrence and a generated part\'s instance, which have no param()s', () => {
    const { container, editParams, openRow, openHeader } = mountParts(
      [instance('gear1', { generated: { definition: 'spur', values: { teeth: 18 } } })],
      [occurrence('asm-0', { generated: { definition: 'crate', values: { width: 40 } } })],
    );
    openHeader('asm-0');
    const header = container.querySelector<HTMLButtonElement>('[data-action="edit-params"]')!;
    expect(header.disabled).toBe(false);
    header.click();
    expect(editParams).toHaveBeenLastCalledWith('occurrence', 'asm-0');
    openRow('gear1');
    container.querySelector<HTMLButtonElement>('[data-action="edit-params"]')!.click();
    expect(editParams).toHaveBeenLastCalledWith('instance', 'gear1');
  });
});

describe('the joints and connectors panels during a preview', () => {
  const mate: SerializedAssemblyMate = {
    mateId: 'mate-0', type: 'revolute', status: 'satisfied',
    connectorA: { instanceId: 'a', connectorId: 'c1' }, connectorB: { instanceId: 'b', connectorId: 'c2' },
    sourceLocation: { filePath: '/ws/shop.assembly.js', line: 7, column: 0 },
  };

  it('keeps Animate on a joint and takes its source actions away', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const joints = new JointsPanel(host, () => {}, () => {}, () => {}, () => {}, () => {}, { onAnimate: () => {} });
    joints.update([mate], [instance('a'), instance('b')]);
    expect(host.querySelector('[data-dots="mate-0"]')).not.toBeNull();
    joints.setReadOnly(true);
    expect(joints.isReadOnly).toBe(true);
    expect(host.querySelector('[data-dots="mate-0"]')).toBeNull();
    expect(host.querySelector('[data-animate="mate-0"]')).not.toBeNull();
    joints.setReadOnly(false);
    expect(host.querySelector('[data-dots="mate-0"]')).not.toBeNull();
  });

  it('takes an assembly connector\'s menu away', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const connectors = new ConnectorsPanel(host, {
      onEdit: () => {}, onEditCopy: () => {}, onCopy: () => {}, onShowInSource: () => {}, onDelete: () => {},
      onRemoveCopies: () => {}, onToggleVisibility: () => {}, isHidden: () => false,
    } as any);
    connectors.update([{
      connectorId: 'w1', name: 'dock', owner: '', origin: { x: 0, y: 0, z: 0 }, xDirection: { x: 1, y: 0, z: 0 },
      yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
      sourceLocation: { filePath: '/ws/shop.assembly.js', line: 2, column: 0 },
    }]);
    expect(host.querySelector('[data-dots]')).not.toBeNull();
    connectors.setReadOnly(true);
    expect(host.querySelector('[data-dots]')).toBeNull();
  });
});

describe('AssemblyPoseWrites — when a moved part is written back', () => {
  const noMate = () => false;
  const mated = () => true;

  it('writes the open file\'s own grounded or unmated part, on its own scene', () => {
    expect(AssemblyPoseWrites.writable(instance('a'), noMate)).toBe(true);
    expect(AssemblyPoseWrites.writable(instance('a', { grounded: true }), mated)).toBe(true);
  });

  it('moves live only: during a preview, an engine-owned part, a sub-assembly\'s, a replica, a mated free part, one with no source', () => {
    previewScene.set('tok');
    expect(previewScene.active).toBe(true);
    expect(AssemblyPoseWrites.writable(instance('a'), noMate)).toBe(false);
    previewScene.set(null);
    expect(AssemblyPoseWrites.writable(instance('a', { generatedBy: { definition: 'crate', type: 'lid' } }), noMate)).toBe(false);
    expect(AssemblyPoseWrites.writable(instance('a', { owner: 'asm-0' }), noMate)).toBe(false);
    expect(AssemblyPoseWrites.writable(instance('a', { replica: { of: 'b', statement: 'rep-0', row: 0 } }), noMate)).toBe(false);
    expect(AssemblyPoseWrites.writable(instance('a'), mated)).toBe(false);
    expect(AssemblyPoseWrites.writable(instance('a', { sourceLocation: undefined }), noMate)).toBe(false);
    expect(AssemblyPoseWrites.writable(undefined, noMate)).toBe(false);
  });

  it('tells its listeners when a preview comes and goes, once each', () => {
    const heard: (string | null)[] = [];
    const off = previewScene.subscribe(token => heard.push(token));
    previewScene.set('tok');
    previewScene.set('tok');
    previewScene.set(null);
    off();
    previewScene.set('later');
    expect(heard).toEqual(['tok', null]);
  });
});

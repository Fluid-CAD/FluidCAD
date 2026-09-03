// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PartsPanel } from '../src/ui/parts-panel';
import { JointsPanel } from '../src/ui/joints-panel';
import type { RenderedInstance, SerializedAssemblyMate, SerializedAssemblyOccurrence } from '../src/types';

// Replicate on the panels: root rows and occurrence headers offer
// "Replicate…" (disabled until mated); replica rows/headers wear the ⧉
// badge and offer only Show in source, Edit replicate… and Remove this
// replica; replicated mates get the badge and lose Edit/Suppress/Delete.

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

function occurrence(id: string, extra: Partial<SerializedAssemblyOccurrence> = {}): SerializedAssemblyOccurrence {
  return {
    occurrenceId: id,
    assemblyName: `sub-${id}`,
    name: `sub-${id}`,
    parentPath: '',
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
    groundConnected: false,
    sourceLocation: { filePath: '/a.assembly.js', line: 9, column: 0 },
    ...extra,
  };
}

function mountParts(instances: RenderedInstance[], occurrences: SerializedAssemblyOccurrence[], mated: Set<string>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const replicate = {
    canReplicate: vi.fn((_kind: string, id: string) => mated.has(id)),
    onReplicate: vi.fn(),
    onEditReplicate: vi.fn(),
    onRemoveReplica: vi.fn(),
  };
  const panel = new PartsPanel(
    container, () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
    { onShowInSource: () => {}, onSetGround: () => {}, onRename: () => {}, onDelete: () => {} },
    undefined,
    { replicate },
  );
  panel.update(instances, occurrences);
  return { container, panel, replicate };
}

function rightClick(container: HTMLElement, selector: string): void {
  container.querySelector<HTMLElement>(selector)!
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
}

function actions(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-action]')].map(b => b.dataset.action!);
}

describe('parts panel replicate entries', () => {
  it('offers Replicate… on a mated root row and fires the handler', () => {
    const { container, replicate } = mountParts([instance('inst-0')], [], new Set(['inst-0']));
    rightClick(container, '[data-instance-id="inst-0"]');
    expect(actions(container)).toEqual(['show-in-source', 'edit-params', 'replicate', 'set-ground', 'rename', 'delete']);
    container.querySelector<HTMLButtonElement>('[data-action="replicate"]')!.click();
    expect(replicate.onReplicate).toHaveBeenCalledWith('instance', 'inst-0');
  });

  it('disables Replicate… with "Mate it first" on an unmated row', () => {
    const { container, replicate } = mountParts([instance('inst-0')], [], new Set());
    rightClick(container, '[data-instance-id="inst-0"]');
    const button = container.querySelector<HTMLButtonElement>('[data-action="replicate"]')!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Mate it first');
    button.click();
    expect(replicate.onReplicate).not.toHaveBeenCalled();
  });

  it('a replica row wears the badge and offers only edit / remove replica', () => {
    const replica = instance('inst-1', { name: 'inst-0 (2)', replica: { of: 'inst-0', statement: 'rep-0', row: 0 } });
    const { container, replicate } = mountParts([instance('inst-0'), replica], [], new Set(['inst-0']));
    expect(container.querySelector('[data-instance-id="inst-1"] [data-replica-badge]')).not.toBeNull();
    expect(container.querySelector('[data-instance-id="inst-0"] [data-replica-badge]')).toBeNull();
    rightClick(container, '[data-instance-id="inst-1"]');
    expect(actions(container)).toEqual(['show-in-source', 'edit-replicate', 'remove-replica']);
    container.querySelector<HTMLButtonElement>('[data-action="remove-replica"]')!.click();
    expect(replicate.onRemoveReplica).toHaveBeenCalledWith('instance', 'inst-1');
    rightClick(container, '[data-instance-id="inst-1"]');
    container.querySelector<HTMLButtonElement>('[data-action="edit-replicate"]')!.click();
    expect(replicate.onEditReplicate).toHaveBeenCalledWith('instance', 'inst-1');
  });

  it('occurrence headers: Replicate… on the seed, edit / remove on a replica', () => {
    const seed = occurrence('asm-0');
    const copy = occurrence('asm-1', { name: 'sub-asm-0 (2)', replica: { of: 'asm-0', statement: 'rep-0', row: 0 } });
    const { container, replicate } = mountParts(
      [instance('asm-0/inst-0', { owner: 'asm-0' }), instance('asm-1/inst-0', { owner: 'asm-1' })],
      [seed, copy],
      new Set(['asm-0']),
    );
    expect(container.querySelector('[data-occurrence-id="asm-1"] [data-replica-badge]')).not.toBeNull();
    rightClick(container, '[data-occurrence-id="asm-0"]');
    expect(actions(container)).toEqual(['show-in-source', 'edit-params', 'replicate', 'set-ground', 'rename', 'delete']);
    container.querySelector<HTMLButtonElement>('[data-action="replicate"]')!.click();
    expect(replicate.onReplicate).toHaveBeenCalledWith('occurrence', 'asm-0');
    rightClick(container, '[data-occurrence-id="asm-1"]');
    expect(actions(container)).toEqual(['show-in-source', 'edit-replicate', 'remove-replica']);
  });
});

describe('joints panel replicated mates', () => {
  function mate(mateId: string, extra: Partial<SerializedAssemblyMate> = {}): SerializedAssemblyMate {
    return {
      mateId,
      owner: '',
      type: 'revolute',
      connectorA: { instanceId: 'inst-0', connectorId: 'c-0' },
      connectorB: { instanceId: 'inst-1', connectorId: 'c-1' },
      status: 'satisfied',
      sourceLocation: { filePath: '/a.assembly.js', line: 7, column: 0 },
      ...extra,
    };
  }

  it('badges replicated mates and offers only Show in source + Animate', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const editMate = vi.fn();
    const panel = new JointsPanel(host, () => {}, () => {}, editMate, () => {}, () => {}, { onAnimate: () => {} });
    panel.update(
      [mate('mate-0'), mate('mate-1', { replica: { of: 'mate-0', statement: 'rep-0', row: 0 } })],
      [instance('inst-0'), instance('inst-1')],
    );
    expect(host.querySelector('[data-mate-id="mate-1"] [data-replica-badge]')).not.toBeNull();
    expect(host.querySelector('[data-mate-id="mate-0"] [data-replica-badge]')).toBeNull();
    host.querySelector<HTMLElement>('[data-mate-id="mate-1"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    expect(actions(host)).toEqual(['show-in-source', 'animate']);
    host.querySelector<HTMLElement>('[data-mate-id="mate-0"]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
    expect(actions(host)).toEqual(['show-in-source', 'animate', 'edit-mate', 'suppress', 'delete']);
  });
});

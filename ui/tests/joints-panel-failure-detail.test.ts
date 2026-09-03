// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { JointsPanel } from '../src/ui/joints-panel';
import type { RenderedInstance, SerializedAssemblyMate } from '../src/types';

// Inconsistent rows carry a misclosure line the solver refreshes per
// solve; `setFailureDetails` patches the text in place (no row rebuild)
// and is a no-op when nothing changed.

function mate(mateId: string, status: SerializedAssemblyMate['status']): SerializedAssemblyMate {
  return {
    mateId,
    owner: '',
    type: 'fastened',
    connectorA: { instanceId: 'inst-0', connectorId: 'conn-0' },
    connectorB: { instanceId: 'inst-1', connectorId: 'conn-1' },
    status,
    sourceLocation: { filePath: '/a.assembly.js', line: 7, column: 0 },
  };
}

function instance(id: string): RenderedInstance {
  return {
    instanceId: id,
    partId: `part-${id}`,
    partName: id,
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
    name: id,
    visible: true,
    sourceLocation: { filePath: '/a.assembly.js', line: 3, column: 0 },
  };
}

function mount(mates: SerializedAssemblyMate[]) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const panel = new JointsPanel(host, () => {}, () => {}, () => {}, () => {}, () => {});
  panel.update(mates, [instance('inst-0'), instance('inst-1')]);
  return { host, panel };
}

const detailOf = (host: HTMLElement, mateId: string) =>
  host.querySelector<HTMLElement>(`[data-failure-detail="${mateId}"]`);

describe('joints panel — failing-mate misclosure line', () => {
  it('only inconsistent rows carry the detail node, filled from the latest details', () => {
    const { host, panel } = mount([mate('ok', 'satisfied'), mate('bad', 'inconsistent')]);
    expect(detailOf(host, 'ok')).toBeNull();
    expect(detailOf(host, 'bad')!.textContent).toBe('');
    panel.setFailureDetails(new Map([['bad', '6.0 mm gap along Y']]));
    expect(detailOf(host, 'bad')!.textContent).toBe('6.0 mm gap along Y');
  });

  it('patches in place without rebuilding rows, and a rebuild keeps the last details', () => {
    const { host, panel } = mount([mate('bad', 'inconsistent')]);
    panel.setFailureDetails(new Map([['bad', '6.0 mm gap along Y']]));
    const node = detailOf(host, 'bad')!;
    panel.setFailureDetails(new Map([['bad', '5.9 mm gap along Y']]));
    expect(detailOf(host, 'bad')).toBe(node);
    expect(node.textContent).toBe('5.9 mm gap along Y');
    panel.update([mate('bad', 'inconsistent')], [instance('inst-0'), instance('inst-1')]);
    expect(detailOf(host, 'bad')!.textContent).toBe('5.9 mm gap along Y');
  });
});

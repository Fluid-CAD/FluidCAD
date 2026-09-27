// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { AssemblyConnectorPanel } from '../src/interactive/assembly-connector/connector-panel';
import { eulerToFrame, frameToEuler, freeName } from '../src/interactive/assembly-connector/connector-service';
import { ConnectorsPanel } from '../src/ui/connectors-panel';

// The assembly-connector dialog: intrinsic XYZ rotation round-trips the
// kernel's `.rotate('x').rotate('y').rotate('z')` chain, fields read as
// numerics or expressions, and the rail section lists connectors with an
// eye toggle and opens the dialog on click.

const close = (a: { x: number; y: number; z: number }, b: [number, number, number]) => {
  expect(a.x).toBeCloseTo(b[0], 6);
  expect(a.y).toBeCloseTo(b[1], 6);
  expect(a.z).toBeCloseTo(b[2], 6);
};

describe('rotation math', () => {
  it("eulerToFrame matches the kernel chain: rotate('x', 90) aims Z along -Y", () => {
    const frame = eulerToFrame([40, 0, 12], [90, 0, 0]);
    close(frame.origin, [40, 0, 12]);
    close(frame.normal, [0, -1, 0]);
    close(frame.xDirection, [1, 0, 0]);
    close(frame.yDirection, [0, 0, 1]);
  });

  it("chains intrinsically: rotate('x', 90).rotate('y', 90) turns about the frame's own Y", () => {
    // Kernel: after rotate('x', 90) the frame's own Y is world Z; rotating
    // 90° about world Z sends X (1,0,0) to (0,1,0).
    const frame = eulerToFrame([0, 0, 0], [90, 90, 0]);
    close(frame.xDirection, [0, 1, 0]);
    // Cross-check against R = Rx·Ry applied to (1,0,0).
    const q = new Quaternion().setFromEuler(new Euler(Math.PI / 2, Math.PI / 2, 0, 'XYZ'));
    const x = new Vector3(1, 0, 0).applyQuaternion(q);
    close(frame.xDirection, [x.x, x.y, x.z]);
  });

  it('frameToEuler inverts eulerToFrame', () => {
    for (const angles of [[0, 0, 0], [90, 0, 0], [0, 90, 0], [0, 0, 45], [30, -60, 120], [-90, 45, 10]] as [number, number, number][]) {
      const frame = eulerToFrame([1, 2, 3], angles);
      const back = frameToEuler(frame);
      const again = eulerToFrame([1, 2, 3], back);
      close(again.xDirection, [frame.xDirection.x, frame.xDirection.y, frame.xDirection.z]);
      close(again.normal, [frame.normal.x, frame.normal.y, frame.normal.z]);
    }
    expect(frameToEuler(eulerToFrame([0, 0, 0], [0, 0, 0]))).toEqual([0, 0, 0]);
  });

  it('freeName skips declared names', () => {
    expect(freeName([])).toBe('c1');
    expect(freeName(['c1', 'c2', 'hinge'])).toBe('c3');
  });
});

describe('AssemblyConnectorPanel', () => {
  function openPanel() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new AssemblyConnectorPanel(container);
    return { panel, container };
  }

  it('reads numerics, expressions and blank fields', () => {
    const { panel, container } = openPanel();
    panel.show({ title: 'Assembly connector', name: 'c1', position: [0, 0, 0], rotation: [0, 0, 0] });
    const input = (role: string) => container.querySelector<HTMLInputElement>(`[data-role="${role}"]`)!;
    input('position-x').value = '40';
    input('position-z').value = 'h / 2';
    input('rotation-x').value = '90';
    const values = panel.values();
    expect(values).toMatchObject({
      name: 'c1',
      position: [{ value: 40 }, { value: 0 }, { value: 'h / 2' }],
      rotation: [{ value: 90 }, { value: 0 }, { value: 0 }],
    });
    expect(panel.isVisible).toBe(true);
  });

  it('rejects a bad name and blocks rotation when seeded null', () => {
    const { panel, container } = openPanel();
    panel.show({ title: 'Edit', name: 'not valid', position: [1, 2, 3], rotation: null, note: 'blocked' });
    expect(panel.values()).toEqual({ error: expect.stringMatching(/connector name/) });
    const rotationX = container.querySelector<HTMLInputElement>('[data-role="rotation-x"]')!;
    expect(rotationX.disabled).toBe(true);
    expect(container.querySelector('[data-role="rotation-note"]')!.textContent).toBe('blocked');
    container.querySelector<HTMLInputElement>('[data-role="name"]')!.value = 'pivot';
    const values = panel.values();
    expect(values).toMatchObject({ name: 'pivot', rotation: null, position: [{ value: 1 }, { value: 2 }, { value: 3 }] });
  });
});

describe('ConnectorsPanel', () => {
  it('lists connectors, opens edit on click, and toggles the eye by name', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const hidden = new Set<string>();
    const edited: string[] = [];
    const panel = new ConnectorsPanel(host, {
      onEdit: (c) => edited.push(c.name),
      onToggleVisibility: (name, visible) => { if (visible) hidden.delete(name); else hidden.add(name); },
      isHidden: (name) => hidden.has(name),
    });
    expect(host.textContent).toContain('No assembly connectors');
    const frame = {
      origin: { x: 0, y: 0, z: 0 }, xDirection: { x: 1, y: 0, z: 0 },
      yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
    };
    panel.update([
      { connectorId: 'w1', name: 'base', owner: '', ...frame },
      { connectorId: 'w2', name: 'hinge', owner: '', ...frame },
    ]);
    const rows = host.querySelectorAll<HTMLElement>('[data-connector-id]');
    expect(rows.length).toBe(2);
    expect(host.textContent).toContain('hinge');
    rows[1].click();
    expect(edited).toEqual(['hinge']);
    host.querySelector<HTMLButtonElement>('[data-eye="base"]')!.click();
    expect(hidden.has('base')).toBe(true);
    expect(edited).toEqual(['hinge']); // the eye click does not open the dialog
    host.querySelector<HTMLButtonElement>('[data-eye="base"]')!.click();
    expect(hidden.has('base')).toBe(false);

    // While the mate dialog is picking the rows read as picks.
    panel.setPickMode(true);
    expect(host.querySelector<HTMLElement>('[data-connector-id="w1"]')!.title).toBe('Pick as the mate side');
    panel.setPickMode(false);
    expect(host.querySelector<HTMLElement>('[data-connector-id="w1"]')!.title).toBe('Edit this connector');
  });
});

// The rail groups an assembly connector's copies (a top-level `copy()`)
// under it: the seed row carries the family's count and a chevron, each
// copy folds out as `instance(k)`, eyes key by label, a copy's row edits
// its copy statement (or picks), and the ⋮ menu names each row's actions.
describe('ConnectorsPanel — copy families', () => {
  const frame = {
    origin: { x: 0, y: 0, z: 0 }, xDirection: { x: 1, y: 0, z: 0 },
    yDirection: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
  };
  const FILE = '/ws/rack.assembly.js';
  const bay = { connectorId: 'w-bay', name: 'bay', owner: '', ...frame, sourceLocation: { filePath: FILE, line: 4, column: 12 } };
  const hinge = { connectorId: 'w-hinge', name: 'hinge', owner: '', ...frame, sourceLocation: { filePath: FILE, line: 5, column: 14 } };
  // Listed out of slot order, as nothing promises the payload's order.
  const copies = [3, 1, 2].map(slot => ({
    connectorId: `w-bay-${slot}`, name: 'bay', owner: '', ...frame,
    sourceLocation: { filePath: FILE, line: 7, column: 0 },
    copy: { slot, seedId: 'w-bay' },
  }));

  function mountPanel() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const hidden = new Set<string>();
    const calls: string[] = [];
    const panel = new ConnectorsPanel(host, {
      onEdit: (c) => calls.push(`edit ${c.connectorId}`),
      onEditCopy: (c) => calls.push(`edit-copy ${c.connectorId}`),
      onPick: (c) => calls.push(`pick ${c.connectorId}`),
      onCopy: (c) => calls.push(`copy ${c.connectorId}`),
      onShowInSource: (c) => calls.push(`source ${c.sourceLocation?.line}`),
      onDelete: (c) => calls.push(`delete ${c.connectorId}`),
      onRemoveCopies: (c) => calls.push(`remove-copies ${c.sourceLocation?.line}`),
      onToggleVisibility: (label, visible) => { if (visible) hidden.delete(label); else hidden.add(label); },
      isHidden: (label) => hidden.has(label),
    });
    panel.update([bay, hinge, ...copies]);
    const rows = () => [...host.querySelectorAll<HTMLElement>('[data-connector-id]')];
    const rowText = () => rows().map(r => r.querySelector('span.truncate')!.textContent);
    const row = (id: string) => host.querySelector<HTMLElement>(`[data-connector-id="${id}"]`)!;
    const openMenu = (id: string) => {
      row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      return [...host.querySelectorAll<HTMLButtonElement>('[data-action]')];
    };
    return { host, panel, hidden, calls, rows, rowText, row, openMenu };
  }

  it('heads a family with the seed: its count and a chevron folding out instance(k) rows in slot order', () => {
    const { host, rowText, row } = mountPanel();
    expect(host.querySelector('[data-ref="count"]')!.textContent).toBe('5');
    expect(rowText()).toEqual(['bay', 'hinge']);
    expect(row('w-bay').querySelector('[data-family-count]')!.textContent).toBe('4');
    expect(row('w-hinge').querySelector('[data-chevron]')).toBeNull();

    row('w-bay').querySelector<HTMLButtonElement>('[data-chevron]')!.click();
    expect(rowText()).toEqual(['bay', 'instance(1)', 'instance(2)', 'instance(3)', 'hinge']);
    // The fold survives the per-render id re-mint: it is keyed by the seed's name.
    row('w-bay').querySelector<HTMLButtonElement>('[data-chevron]')!.click();
    expect(rowText()).toEqual(['bay', 'hinge']);
  });

  it('keys eyes by label: a copy hides alone, the seed row hides the whole family', () => {
    const { host, hidden, row } = mountPanel();
    row('w-bay').querySelector<HTMLButtonElement>('[data-chevron]')!.click();
    host.querySelector<HTMLButtonElement>('[data-eye="bay.instance(2)"]')!.click();
    expect([...hidden]).toEqual(['bay.instance(2)']);

    host.querySelector<HTMLButtonElement>('[data-eye="bay.instance(2)"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-eye="bay"]')!.click();
    expect([...hidden].sort()).toEqual(['bay', 'bay.instance(1)', 'bay.instance(2)', 'bay.instance(3)']);
    host.querySelector<HTMLButtonElement>('[data-eye="bay"]')!.click();
    expect([...hidden]).toEqual([]);
  });

  it('a copy row edits the statement that made it, and is a pick while a dialog picks', () => {
    const { panel, calls, row } = mountPanel();
    row('w-bay').querySelector<HTMLButtonElement>('[data-chevron]')!.click();
    row('w-bay-2').click();
    row('w-bay').click();
    expect(calls).toEqual(['edit-copy w-bay-2', 'edit w-bay']);

    panel.setPickMode(true, 'Pick for the copy');
    expect(row('w-bay-2').title).toBe('Pick for the copy');
    row('w-bay-2').click();
    row('w-hinge').click();
    expect(calls.slice(2)).toEqual(['pick w-bay-2', 'pick w-hinge']);
  });

  it('offers Copy… on a connector nothing copies, Edit copy… once one does, and a copy\'s own actions', () => {
    const { calls, row, openMenu } = mountPanel();
    const labels = (items: HTMLButtonElement[]) => items.map(item => item.textContent!.trim());

    expect(labels(openMenu('w-hinge'))).toEqual(['Show in source', 'Copy…', 'Delete']);
    openMenu('w-hinge').find(item => item.dataset.action === 'copy')!.click();
    expect(calls).toEqual(['copy w-hinge']);

    expect(labels(openMenu('w-bay'))).toEqual(['Show in source', 'Edit copy…', 'Delete']);
    openMenu('w-bay').find(item => item.dataset.action === 'edit-copy')!.click();
    expect(calls.at(-1)).toMatch(/^edit-copy w-bay-\d$/);

    row('w-bay').querySelector<HTMLButtonElement>('[data-chevron]')!.click();
    expect(labels(openMenu('w-bay-1'))).toEqual(['Show in source', 'Edit copy…', 'Remove copies']);
    openMenu('w-bay-1').find(item => item.dataset.action === 'show-in-source')!.click();
    openMenu('w-bay-1').find(item => item.dataset.action === 'remove-copies')!.click();
    openMenu('w-bay').find(item => item.dataset.action === 'delete')!.click();
    expect(calls.slice(-3)).toEqual(['source 7', 'remove-copies 7', 'delete w-bay']);
  });
});

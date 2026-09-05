// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { JointsPanel } from '../src/ui/joints-panel';
import type { RenderedInstance, SerializedAssemblyMate } from '../src/types';

// The joints-panel row menu: reachable by right-click as well as the ⋮
// button, "Edit mate…" routing to its callback — and, like the parts panel's
// owned rows, sub-assembly-owned mates offering only Show in source.

function mate(mateId: string, owner = ''): SerializedAssemblyMate {
  return {
    mateId,
    owner,
    type: 'revolute',
    connectorA: { instanceId: 'inst-0', connectorId: 'conn-0' },
    connectorB: { instanceId: 'inst-1', connectorId: 'conn-1' },
    status: 'satisfied',
    options: { limits: [0, 90] },
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

type Harness = {
  host: HTMLElement;
  panel: JointsPanel;
  editMate: ReturnType<typeof vi.fn>;
  showInSource: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

function mount(mates: SerializedAssemblyMate[], onAnimate?: (mateId: string) => void): Harness {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editMate = vi.fn();
  const showInSource = vi.fn();
  const del = vi.fn();
  const panel = new JointsPanel(host, () => {}, showInSource, editMate, () => {}, del, { onAnimate });
  panel.update(mates, [instance('inst-0'), instance('inst-1')]);
  return { host, panel, editMate, showInSource, del };
}

function rightClickRow(host: HTMLElement, mateId: string): void {
  const row = host.querySelector<HTMLElement>(`[data-mate-id="${mateId}"]`)!;
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
}

describe('joints panel row menu', () => {
  it('opens on right-click with all four actions', () => {
    const { host } = mount([mate('mate-0')]);
    expect(host.querySelector('[data-action="edit-mate"]')).toBeNull();

    rightClickRow(host, 'mate-0');

    for (const action of ['show-in-source', 'edit-mate', 'suppress', 'delete']) {
      expect(host.querySelector(`[data-action="${action}"]`), action).not.toBeNull();
    }
    expect(host.querySelector('[data-action="edit-mate"]')!.textContent).toContain('Edit mate');
  });

  it('offers Animate… on slider/revolute rows only when a handler is wired', () => {
    const plain = mount([mate('mate-0')]);
    rightClickRow(plain.host, 'mate-0');
    expect(plain.host.querySelector('[data-action="animate"]')).toBeNull();

    const animate = vi.fn();
    const fastened: SerializedAssemblyMate = { ...mate('mate-1'), type: 'fastened' };
    const owned = mate('mate-2', 'sub');
    const { host } = mount([mate('mate-0'), fastened, owned], animate);
    rightClickRow(host, 'mate-1');
    expect(host.querySelector('[data-action="animate"]')).toBeNull();
    // Non-mutating, so owned (sub-assembly) mates get it too.
    rightClickRow(host, 'mate-2');
    expect(host.querySelector('[data-action="animate"]')).not.toBeNull();
    expect(host.querySelector('[data-action="edit-mate"]')).toBeNull();
    rightClickRow(host, 'mate-0');
    host.querySelector<HTMLElement>('[data-action="animate"]')!.click();
    expect(animate).toHaveBeenCalledWith('mate-0');
    expect(host.querySelector('[data-action="animate"]')).toBeNull(); // menu closed
  });

  it('read-only host: a play button and an Animate-only menu on animatable rows, nothing else', () => {
    const animate = vi.fn();
    const fastened: SerializedAssemblyMate = { ...mate('mate-1'), type: 'fastened' };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const panel = new JointsPanel(host, () => {}, () => {}, () => {}, () => {}, () => {}, { readOnly: true, onAnimate: animate });
    panel.update([mate('mate-0'), fastened], [instance('inst-0'), instance('inst-1')]);

    // No ⋮ anywhere; the play button only on the revolute row.
    expect(host.querySelector('[data-dots]')).toBeNull();
    expect(host.querySelector('[data-animate="mate-0"]')).not.toBeNull();
    expect(host.querySelector('[data-animate="mate-1"]')).toBeNull();
    host.querySelector<HTMLElement>('[data-animate="mate-0"]')!.click();
    expect(animate).toHaveBeenCalledWith('mate-0');

    // Right-click: Animate… alone on the revolute row, no menu at all on the fastened one.
    rightClickRow(host, 'mate-0');
    expect(host.querySelectorAll('[data-action]').length).toBe(1);
    expect(host.querySelector('[data-action="animate"]')).not.toBeNull();
    rightClickRow(host, 'mate-1');
    expect(host.querySelector('[data-action]')).toBeNull();

    // Without a handler the read-only panel stays inert.
    const inert = new JointsPanel(host, () => {}, () => {}, () => {}, () => {}, () => {}, { readOnly: true });
    inert.update([mate('mate-9')], [instance('inst-0'), instance('inst-1')]);
    expect(host.querySelector('[data-animate="mate-9"]')).toBeNull();
    rightClickRow(host, 'mate-9');
    expect(host.querySelector('[data-action]')).toBeNull();
  });

  it('routes Edit mate to the row it was opened on', () => {
    const { host, editMate } = mount([mate('mate-0'), mate('mate-1')]);
    rightClickRow(host, 'mate-1');
    host.querySelector<HTMLElement>('[data-action="edit-mate"]')!.click();
    expect(editMate).toHaveBeenCalledWith('mate-1');
    expect(host.querySelector('[data-action="edit-mate"]')).toBeNull(); // menu closed
  });

  it('opens from the ⋮ button too', () => {
    const { host, editMate } = mount([mate('mate-0')]);
    host.querySelector<HTMLElement>('[data-dots="mate-0"]')!.click();
    host.querySelector<HTMLElement>('[data-action="edit-mate"]')!.click();
    expect(editMate).toHaveBeenCalledWith('mate-0');
  });

  it('positions the menu at the cursor / below the ⋮, relative to its host', () => {
    const { host } = mount([mate('mate-0')]);
    // The host is the menu's positioning context — without this the absolute
    // dropdown resolves against a higher ancestor and lands offset by
    // whatever sits above the joints section.
    expect(host.classList.contains('relative')).toBe(true);
    host.getBoundingClientRect = () => ({
      top: 100, left: 20, right: 240, bottom: 500, width: 220, height: 400, x: 20, y: 100,
      toJSON: () => ({}),
    }) as DOMRect;

    const row = host.querySelector<HTMLElement>('[data-mate-id="mate-0"]')!;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 260 }));
    let menu = host.querySelector<HTMLElement>('.absolute.z-\\[200\\]')!;
    expect(menu.style.top).toBe('160px');
    expect(menu.style.left).toBe('70px');

    const dots = host.querySelector<HTMLElement>('[data-dots="mate-0"]')!;
    dots.getBoundingClientRect = () => ({
      top: 280, left: 200, right: 214, bottom: 294, width: 14, height: 14, x: 200, y: 280,
      toJSON: () => ({}),
    }) as DOMRect;
    dots.click();
    menu = host.querySelector<HTMLElement>('.absolute.z-\\[200\\]')!;
    expect(menu.style.top).toBe('196px'); // button bottom − host top + 2
    expect(menu.style.left).toBe('40px'); // button left − host left − 140
  });

  it('offers ONLY Show in source on sub-assembly-owned mates', () => {
    const { host, showInSource } = mount([mate('asm-0/mate-0', 'asm-0')]);
    rightClickRow(host, 'asm-0/mate-0');
    expect(host.querySelector('[data-action="show-in-source"]')).not.toBeNull();
    expect(host.querySelector('[data-action="edit-mate"]')).toBeNull();
    expect(host.querySelector('[data-action="suppress"]')).toBeNull();
    expect(host.querySelector('[data-action="delete"]')).toBeNull();
    host.querySelector<HTMLElement>('[data-action="show-in-source"]')!.click();
    expect(showInSource).toHaveBeenCalledWith('asm-0/mate-0');
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { JointsPanel } from '../src/ui/joints-panel';
import { MateLabel } from '../src/ui/mate-label';
import type { RenderedInstance, SerializedAssemblyMate, SerializedAssemblyRelation } from '../src/types';

// A joint reads by its authored name when it has one — the user's
// mate(...).name('Hinge') and a generator's g.mate(...).name('Left door')
// alike — with its kind beside it as quieter text; an unnamed one reads by
// its kind, as before. Relation rows follow the same rule, and the joints a
// relation couples are described by name too.

function mate(mateId: string, overrides: Partial<SerializedAssemblyMate> = {}): SerializedAssemblyMate {
  return {
    mateId,
    owner: '',
    type: 'revolute',
    connectorA: { instanceId: 'inst-0', connectorId: 'conn-0' },
    connectorB: { instanceId: 'inst-1', connectorId: 'conn-1' },
    status: 'satisfied',
    options: { limits: [0, 110] },
    sourceLocation: { filePath: '/a.assembly.js', line: 7, column: 0 },
    ...overrides,
  };
}

function instance(id: string, name: string): RenderedInstance {
  return {
    instanceId: id,
    partId: `part-${id}`,
    partName: name,
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    grounded: false,
    name,
    visible: true,
    sourceLocation: { filePath: '/a.assembly.js', line: 3, column: 0 },
  };
}

function relation(overrides: Partial<SerializedAssemblyRelation> = {}): SerializedAssemblyRelation {
  return {
    relationId: 'rel-0', owner: '', type: 'gear', mateA: 'mate-0', mateB: 'mate-1', ratio: 2, reverse: false,
    sourceLocation: { filePath: '/a.assembly.js', line: 9, column: 0 },
    ...overrides,
  };
}

const hosts: HTMLElement[] = [];

function mount(mates: SerializedAssemblyMate[], relations: SerializedAssemblyRelation[] = [], readOnly = false): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const panel = new JointsPanel(host, () => {}, () => {}, () => {}, () => {}, () => {}, { readOnly, onAnimate: () => {} });
  panel.update(mates, [instance('inst-0', 'Carcass'), instance('inst-1', 'Left door')], [], relations);
  return host;
}

const row = (host: HTMLElement, selector: string) => host.querySelector<HTMLElement>(selector)!;
const title = (el: HTMLElement) => el.querySelector('[data-joint-title]')?.textContent;
const kind = (el: HTMLElement) => el.querySelector('[data-joint-kind]')?.textContent ?? null;

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.remove();
  }
});

describe('joint rows by name', () => {
  it('leads a named mate with its name and keeps its type beside it', () => {
    const host = mount([mate('mate-0', { name: 'Left door' })]);
    const named = row(host, '[data-mate-id="mate-0"]');
    expect(title(named)).toBe('Left door');
    expect(kind(named)).toBe('revolute');
    // The sides and the limits stay under it.
    expect(named.textContent).toContain('Carcass');
    expect(named.textContent).toContain('0 – 110°');
  });

  it('leads an unnamed mate, or one whose name is blank, with its type and nothing beside it', () => {
    const host = mount([mate('mate-0'), mate('mate-1', { type: 'slider', name: '  ', options: { limits: [0, 450] } })]);
    for (const [id, type] of [['mate-0', 'revolute'], ['mate-1', 'slider']]) {
      const plain = row(host, `[data-mate-id="${id}"]`);
      expect(title(plain)).toBe(type);
      expect(kind(plain)).toBeNull();
    }
  });

  it('reads the same while the panel is read-only (an assembly preview, a generated assembly\'s rows)', () => {
    const host = mount([mate('mate-0', { name: 'Drawer 2', type: 'slider', owner: 'asm-0' })], [], true);
    const owned = row(host, '[data-mate-id="mate-0"]');
    expect(title(owned)).toBe('Drawer 2');
    expect(kind(owned)).toBe('slider');
    expect(owned.querySelector('[data-animate="mate-0"]')).not.toBeNull();
  });

  it('escapes a name as text', () => {
    const host = mount([mate('mate-0', { name: '<b>Hinge</b>' })]);
    const named = row(host, '[data-mate-id="mate-0"]');
    expect(title(named)).toBe('<b>Hinge</b>');
    expect(named.querySelector('b')).toBeNull();
  });
});

describe('relation rows by name', () => {
  it('leads a named relation with its name and its coupling beside it; an unnamed one with the coupling', () => {
    const mates = [mate('mate-0', { name: 'Pinion' }), mate('mate-1')];
    const named = row(mount(mates, [relation({ name: 'Drive', reverse: true })]), '[data-relation-id="rel-0"]');
    expect(title(named)).toBe('Drive');
    expect(kind(named)).toBe('Gear × 2 · reverse');
    const plain = row(mount(mates, [relation()]), '[data-relation-id="rel-0"]');
    expect(title(plain)).toBe('Gear × 2');
    expect(kind(plain)).toBeNull();
  });

  it('describes the joints it couples by their names, unnamed ones by type', () => {
    const host = mount([mate('mate-0', { name: 'Pinion' }), mate('mate-1')], [relation()]);
    const lines = [...row(host, '[data-relation-id="rel-0"]').querySelectorAll('.pl-11')].map(el => el.textContent);
    expect(lines).toEqual(['Pinion (Revolute) · Carcass ↔ Left door', 'Revolute · Carcass ↔ Left door']);
  });
});

describe('MateLabel', () => {
  it('describes a named mate by its name and type, an unnamed one by its type', () => {
    const names = new Map([['inst-0', 'Carcass'], ['inst-1', 'Left door']]);
    expect(MateLabel.describe(mate('m', { name: 'Left door' }), names, new Map())).toBe('Left door (Revolute) · Carcass ↔ Left door');
    expect(MateLabel.describe(mate('m'), names, new Map())).toBe('Revolute · Carcass ↔ Left door');
  });

  it('heads a row with the name and the kind, or the kind alone', () => {
    expect(MateLabel.heading('Left door', 'revolute')).toEqual({ title: 'Left door', kind: 'revolute' });
    expect(MateLabel.heading(undefined, 'revolute')).toEqual({ title: 'revolute', kind: null });
    expect(MateLabel.heading('', 'Gear × 2')).toEqual({ title: 'Gear × 2', kind: null });
    expect(MateLabel.nameOf({ name: ' Hinge ' })).toBe('Hinge');
    expect(MateLabel.nameOf({})).toBeNull();
  });
});

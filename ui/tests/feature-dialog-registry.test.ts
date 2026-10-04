import { beforeEach, describe, expect, it } from 'vitest';
import {
  FeatureDialogRegistry, ServiceDialog, type FeatureDialogExit,
} from '../src/interactive/feature-dialog-registry';
import { PartFeatureDialogs, type PartDialogServices } from '../src/interactive/part-feature-dialogs';
import type { FeatureEditTarget, ParsedFeatureStatement } from '../src/api';
import type { SceneObjectRender, SubSelection } from '../src/types';
import type { FeatureButton } from '../src/interactive/create-feature/feature-button';

// The part-mode dialogs used to be hand-wired into main.ts: one `||` chain per
// pick channel, one exit() list per dialog, one list per toolbar sync. The
// registry replaces every one of them, so these tests pin what each chain
// said: who takes which pick in which armed state, which dialogs pin the
// sketch toolbar or block the Sketch button, which rows each one edits —
// and the order and the one-dialog-at-a-time rule that make the chains'
// old, differing orders irrelevant.

/**
 * A stand-in for a create-feature service: every pick-state getter the
 * claims read is a flag gated on `armed`, as in every real service, and
 * every handler records its call.
 */
class FakeService {
  armed = false;
  editing = false;
  suspended = false;
  facePicking = false;
  scopePicking = false;
  edgePicking = false;
  axisPicking = false;
  connectorPicking = false;
  planePicking = false;
  calls: string[] = [];
  edits: unknown[][] = [];
  readonly toolbarButton: FeatureButton;

  constructor(readonly name: string, private readonly onEnter?: () => void) {
    this.toolbarButton = { name } as unknown as FeatureButton;
  }

  get isActive(): boolean {
    return this.armed;
  }

  get isEditing(): boolean {
    return this.editing;
  }

  get sketchUISuspended(): boolean {
    return this.suspended;
  }

  get isPicking(): boolean {
    return this.armed;
  }

  get isFacePicking(): boolean {
    return this.armed && this.facePicking;
  }

  get isScopePicking(): boolean {
    return this.armed && this.scopePicking;
  }

  get isEdgePicking(): boolean {
    return this.armed && this.edgePicking;
  }

  get isAxisPicking(): boolean {
    return this.armed && this.axisPicking;
  }

  get isPlanePicking(): boolean {
    return this.armed && this.planePicking;
  }

  get isConnectorPicking(): boolean {
    return this.armed && this.connectorPicking;
  }

  /** What every real service does: the onEnter hook runs, then it arms. */
  enter(): void {
    if (this.armed) {
      return;
    }
    this.onEnter?.();
    this.armed = true;
  }

  exit(opts?: FeatureDialogExit | string): void {
    const end = typeof opts === 'string' ? opts : opts?.editEnd;
    this.calls.push(end ? `exit:${end}` : 'exit');
    this.armed = false;
    this.editing = false;
  }

  enterEdit(...args: unknown[]): void {
    this.edits.push(args);
  }

  handleSceneRendered(): void {
    this.calls.push('render');
  }

  handleClick(): void {
    this.calls.push('click');
  }

  handleTimelinePick(): boolean {
    this.calls.push('timeline');
    return this.armed;
  }

  handleSketchPick(): boolean {
    this.calls.push('sketch');
    return this.armed;
  }

  handlePlanePick(): void {
    this.calls.push('plane');
  }

  handleConnectorPick(): void {
    this.calls.push('connector');
  }

  handleHover(): void {
    this.calls.push('hover');
  }

  handleContextMenu(): void {
    this.calls.push('context');
  }

  handleDoubleClick(): void {
    this.calls.push('dblclick');
  }
}

const PART_ORDER = [
  'extrude', 'rib', 'hole', 'revolve', 'sweep', 'wrap', 'loft', 'helix',
  'repeat', 'copy', 'mirror', 'rotate', 'connector', 'boolean', 'plane', 'text',
] as const;
type PartId = typeof PART_ORDER[number];

const FACE: SubSelection = { type: 'face', index: 0 } as SubSelection;
const AXIS: SubSelection = { type: 'axis', index: 0 } as SubSelection;
const ROW = { id: 'r1', type: 'sketch' } as unknown as SceneObjectRender;
const TARGET = { filePath: '/w/model.part.js', line: 3, column: 1 } as FeatureEditTarget;
const INFO = { index: 2, type: 'x', expectedStatement: 'x()' };

describe('FeatureDialogRegistry', () => {
  function fakeDialog(id: string, service: FakeService) {
    return new ServiceDialog(id, service, {
      picking: (s) => s.isPicking,
      claims: { click: (s) => s.isPicking },
      timelinePicks: true,
    });
  }

  it('offers a pick in registration order and stops at the first taker', () => {
    const registry = new FeatureDialogRegistry();
    const a = new FakeService('a');
    const b = new FakeService('b');
    registry.register(fakeDialog('a', a));
    registry.register(fakeDialog('b', b));
    a.armed = true;
    b.armed = true;
    expect(registry.routeClick('s1', FACE)).toBe(true);
    expect(a.calls).toEqual(['click']);
    expect(b.calls).toEqual([]);
    expect(registry.routeTimelinePick(ROW)).toBe(true);
    expect(b.calls).toEqual([]);
  });

  it('answers false when no dialog claims the pick, and never runs an unclaimed handler', () => {
    const registry = new FeatureDialogRegistry();
    const a = new FakeService('a');
    registry.register(fakeDialog('a', a));
    expect(registry.routeClick(null, FACE)).toBe(false);
    expect(registry.routePlanePick('q')).toBe(false);
    expect(registry.routeAxisPick('x', AXIS)).toBe(false);
    expect(a.calls).toEqual([]);
    // Timeline picks are the service's own to refuse: it is asked, it says no.
    expect(registry.routeTimelinePick(ROW)).toBe(false);
    expect(a.calls).toEqual(['timeline']);
  });

  it('refuses a second dialog under the same id', () => {
    const registry = new FeatureDialogRegistry();
    registry.register(fakeDialog('a', new FakeService('a')));
    expect(() => registry.register(fakeDialog('a', new FakeService('a')))).toThrow(/already registered/);
  });

  it('exits every dialog but the one opening, and Continue ends only open edit sessions', () => {
    const registry = new FeatureDialogRegistry();
    const services = ['a', 'b', 'c'].map((n) => new FakeService(n));
    services.forEach((s) => registry.register(fakeDialog(s.name, s)));
    registry.exitAll({ except: 'b' });
    expect(services.map((s) => s.calls)).toEqual([['exit'], [], ['exit']]);

    services.forEach((s) => { s.calls = []; });
    services[0].armed = true;
    services[2].armed = true;
    services[2].editing = true;
    registry.continueEdits();
    expect(services.map((s) => s.calls)).toEqual([[], [], ['exit:continue']]);
    expect(services[0].armed).toBe(true);
  });

  it('hands each render to every dialog, in order', () => {
    const registry = new FeatureDialogRegistry();
    const order: string[] = [];
    for (const name of ['a', 'b']) {
      const service = new FakeService(name);
      service.handleSceneRendered = () => order.push(name);
      registry.register(fakeDialog(name, service));
    }
    registry.handleSceneRendered([], -1, false);
    expect(order).toEqual(['a', 'b']);
  });

  it('opens an edit only for the parsed kind its dialog declared', () => {
    const registry = new FeatureDialogRegistry();
    const service = new FakeService('rib');
    registry.register(new ServiceDialog('rib', service, {
      edit: { rowTypes: ['rib'], kind: 'rib', open: (t, p, i, row) => service.enterEdit(t, p, i, row) },
      picking: () => false,
    }));
    const rib = { feature: 'rib' } as ParsedFeatureStatement;
    expect(registry.editsRowType('rib')).toBe(true);
    expect(registry.editsRowType('extrude')).toBe(false);
    expect(registry.forParsedFeature('extrude')).toBeNull();
    const dialog = registry.forParsedFeature('rib');
    dialog!.enterEdit!(TARGET, rib, INFO, ROW);
    // A mismatched parse is never handed to the service.
    dialog!.enterEdit!(TARGET, { feature: 'extrude' } as ParsedFeatureStatement, INFO, ROW);
    expect(service.edits).toEqual([[TARGET, rib, INFO, ROW]]);
    expect(registry.forStatement(rib)).toBe(dialog);
  });

  it('takes a dialog out of every chain, closing it first', () => {
    const registry = new FeatureDialogRegistry();
    const a = new FakeService('a');
    const b = new FakeService('b');
    registry.register(fakeDialog('a', a));
    registry.register(fakeDialog('b', b));
    a.armed = true;
    registry.unregister('a');
    expect(a.calls).toEqual(['exit']);
    expect(registry.ids).toEqual(['b']);
    expect(registry.get('a')).toBeNull();
    b.armed = true;
    expect(registry.routeClick('s1', FACE)).toBe(true);
    expect(a.calls).toEqual(['exit']);
    // An id that was never registered (or already left) is nothing to take out.
    registry.unregister('a');
    // The id is free again.
    registry.register(fakeDialog('a', new FakeService('a')));
    expect(registry.ids).toEqual(['b', 'a']);
  });
});

describe('PartFeatureDialogs', () => {
  let registry: FeatureDialogRegistry;
  let fakes: Record<PartId, FakeService>;

  beforeEach(() => {
    registry = new FeatureDialogRegistry();
    // The shared onEnter every dialog runs before it arms (main.ts's
    // enterPartDialog): close every other registered dialog.
    fakes = Object.fromEntries(PART_ORDER.map((id) => [
      id, new FakeService(id, () => registry.exitAll({ except: id })),
    ])) as Record<PartId, FakeService>;
    PartFeatureDialogs.register(registry, fakes as unknown as PartDialogServices);
  });

  /** Arm one dialog, with whatever pick state the case needs. */
  function arm(id: PartId, state: Partial<FakeService> = {}): FakeService {
    const service = fakes[id];
    Object.assign(service, { armed: true, ...state });
    return service;
  }

  /** Which dialogs' handlers ran for the last pick. */
  function takers(call: string): string[] {
    return PART_ORDER.filter((id) => fakes[id].calls.includes(call));
  }

  it('registers the dialogs in the scene fan-out order', () => {
    expect(registry.ids).toEqual([...PART_ORDER]);
  });

  it('keeps one dialog open at a time: opening one exits every other', () => {
    for (const id of PART_ORDER) {
      fakes[id].enter();
      const open = PART_ORDER.filter((other) => fakes[other].isActive);
      expect(open).toEqual([id]);
    }
    // And back again, in reverse.
    for (const id of [...PART_ORDER].reverse()) {
      fakes[id].enter();
      expect(PART_ORDER.filter((other) => fakes[other].isActive)).toEqual([id]);
    }
  });

  it('gives a viewport click to the armed dialog only while its click slot is armed', () => {
    const plainClickers: PartId[] = ['rib', 'hole', 'helix', 'repeat', 'copy', 'mirror', 'rotate', 'connector', 'boolean', 'plane'];
    for (const id of plainClickers) {
      const service = arm(id);
      expect(registry.routeClick('s1', FACE), id).toBe(true);
      expect(takers('click')).toEqual([id]);
      service.exit();
      service.calls = [];
    }
    // Extrude takes faces only for "Up to face" or an armed scope slot.
    arm('extrude');
    expect(registry.routeClick('s1', FACE)).toBe(false);
    fakes.extrude.facePicking = true;
    expect(registry.routeClick('s1', FACE)).toBe(true);
    fakes.extrude.facePicking = false;
    fakes.extrude.scopePicking = true;
    expect(registry.routeClick('s1', FACE)).toBe(true);
    fakes.extrude.exit();
    // Revolve, sweep, wrap and loft by their own pick states.
    const byState: [PartId, keyof FakeService][] = [
      ['revolve', 'axisPicking'], ['sweep', 'edgePicking'], ['wrap', 'facePicking'], ['loft', 'facePicking'],
    ];
    for (const [id, flag] of byState) {
      arm(id);
      expect(registry.routeClick('s1', FACE), id).toBe(false);
      Object.assign(fakes[id], { [flag]: true });
      expect(registry.routeClick('s1', FACE), id).toBe(true);
      fakes[id].exit();
      Object.assign(fakes[id], { [flag]: false });
    }
    // The text dialog takes no viewport picks.
    arm('text');
    expect(registry.routeClick('s1', FACE)).toBe(false);
  });

  it('routes axis-line picks to the armed axis slot, through the service click handler', () => {
    for (const id of ['repeat', 'copy', 'rotate', 'helix', 'revolve'] as PartId[]) {
      arm(id);
      expect(registry.routeAxisPick('a1', AXIS), id).toBe(false);
      fakes[id].axisPicking = true;
      expect(registry.routeAxisPick('a1', AXIS), id).toBe(true);
      expect(takers('click')).toEqual([id]);
      fakes[id].exit();
      fakes[id].axisPicking = false;
      fakes[id].calls = [];
    }
    arm('extrude', { axisPicking: true });
    expect(registry.routeAxisPick('a1', AXIS)).toBe(false);
  });

  it('routes plane quads, connector gizmos and sketch wires to the dialogs that take them', () => {
    for (const id of ['repeat', 'mirror', 'plane'] as PartId[]) {
      arm(id);
      expect(registry.routePlanePick('q1'), id).toBe(false);
      fakes[id].planePicking = true;
      expect(registry.routePlanePick('q1'), id).toBe(true);
      fakes[id].exit();
      fakes[id].planePicking = false;
    }
    arm('wrap', { planePicking: true });
    expect(registry.routePlanePick('q1')).toBe(false);
    fakes.wrap.exit();

    const connectorTakers: PartId[] = ['hole', 'copy', 'repeat'];
    for (const id of PART_ORDER) {
      arm(id);
      expect(registry.routeConnectorPick('c1', {}), id).toBe(connectorTakers.includes(id));
      fakes[id].exit();
    }
    // An armed axis slot takes a connector gizmo — its Z axis — and only then.
    for (const id of PART_ORDER) {
      fakes[id].calls = [];
    }
    for (const id of ['revolve', 'helix', 'rotate'] as PartId[]) {
      arm(id, { axisPicking: true });
      expect(registry.routeConnectorPick('c1', {}), id).toBe(false);
      fakes[id].connectorPicking = true;
      expect(registry.routeConnectorPick('c1', {}), id).toBe(true);
      expect(takers('connector')).toEqual([id]);
      fakes[id].exit();
      fakes[id].connectorPicking = false;
      fakes[id].calls = [];
    }

    const sketchTakers: PartId[] = ['extrude', 'rib', 'revolve', 'sweep', 'wrap', 'loft', 'plane'];
    for (const id of PART_ORDER) {
      arm(id);
      expect(registry.routeSketchPick('w1'), id).toBe(sketchTakers.includes(id));
      fakes[id].exit();
    }
  });

  it('routes timeline picks to every dialog with timeline slots', () => {
    const takersOfRows = PART_ORDER.filter((id) => id !== 'connector' && id !== 'text');
    for (const id of PART_ORDER) {
      arm(id);
      expect(registry.routeTimelinePick(ROW), id).toBe(takersOfRows.includes(id));
      fakes[id].exit();
    }
  });

  it('routes hover to the anchor rails, and the right-click menu and double-click to sweep path picking', () => {
    arm('connector');
    expect(registry.routeHover('s1', FACE, 1, 2)).toBe(true);
    fakes.connector.exit();
    arm('hole');
    expect(registry.routeHover('s1', FACE, 1, 2)).toBe(true);
    fakes.hole.exit();
    arm('extrude', { facePicking: true });
    expect(registry.routeHover('s1', FACE, 1, 2)).toBe(false);
    fakes.extrude.exit();

    arm('sweep');
    expect(registry.routeContextMenu('s1', FACE, 1, 2)).toBe(false);
    fakes.sweep.edgePicking = true;
    expect(registry.routeContextMenu('s1', FACE, 1, 2)).toBe(true);
    expect(registry.routeDoubleClick('s1', FACE)).toBe(true);
    expect(fakes.sweep.calls).toEqual(['context', 'dblclick']);
  });

  it('reads which dialogs own the viewport for the neutral-mode menu', () => {
    expect(registry.isPicking).toBe(false);
    // Extrude and sweep own it while creating, but in an edit session only
    // while a face, scope or path slot picks.
    arm('extrude', { editing: true });
    expect(registry.isPicking).toBe(false);
    fakes.extrude.scopePicking = true;
    expect(registry.isPicking).toBe(true);
    fakes.extrude.exit();
    fakes.extrude.scopePicking = false;
    arm('extrude');
    expect(registry.isPicking).toBe(true);
    fakes.extrude.exit();
    arm('sweep', { editing: true });
    expect(registry.isPicking).toBe(false);
    fakes.sweep.edgePicking = true;
    expect(registry.isPicking).toBe(true);
    fakes.sweep.exit();
    fakes.sweep.edgePicking = false;
    // Revolve by its axis slot, wrap and loft by their face slots.
    arm('revolve');
    expect(registry.isPicking).toBe(false);
    fakes.revolve.exit();
    arm('text');
    expect(registry.isPicking).toBe(false);
    fakes.text.exit();
    arm('boolean');
    expect(registry.isPicking).toBe(true);
  });

  it('pins the sketch toolbar for the sketch-finishing dialogs, and blocks the Sketch button for all but text', () => {
    const pinners = PART_ORDER.filter((id) => {
      arm(id, { suspended: true });
      const pinned = registry.pinsSketchToolbar;
      fakes[id].exit();
      fakes[id].suspended = false;
      return pinned;
    });
    expect(pinners).toEqual(['extrude', 'rib', 'hole', 'revolve', 'sweep', 'wrap', 'loft', 'connector', 'plane']);
    // Armed but not suspended (armed outside a sketch): no pin.
    arm('extrude');
    expect(registry.pinsSketchToolbar).toBe(false);
    fakes.extrude.exit();

    const blockers = PART_ORDER.filter((id) => {
      arm(id);
      const blocked = registry.blocksSketchButton;
      fakes[id].exit();
      return blocked;
    });
    expect(blockers).toEqual(PART_ORDER.filter((id) => id !== 'text'));
  });

  it('reports a suspended sketch UI for any dialog, the text dialog while it is open', () => {
    expect(registry.sketchUISuspended).toBe(false);
    fakes.connector.suspended = true;
    expect(registry.sketchUISuspended).toBe(true);
    fakes.connector.suspended = false;
    arm('text');
    expect(registry.sketchUISuspended).toBe(true);
  });

  it('hands Finish Sketch the create-group buttons', () => {
    const names = registry.toolbarButtons.map((b) => (b as unknown as { name: string }).name);
    expect(names).toEqual(['extrude', 'rib', 'hole', 'revolve', 'sweep', 'wrap', 'loft', 'helix', 'plane']);
  });

  it('edits the rows each dialog owns, and opens the dialog for its parsed kind', () => {
    const rowTypes = [
      'extrude', 'cut', 'rib', 'hole', 'revolve', 'sweep', 'wrap', 'loft', 'helix',
      'repeat-linear', 'repeat-circular', 'repeat-matrix', 'copy-linear', 'copy-circular', 'copy-pattern',
      'mirror', 'rotate', 'connector', 'fuse', 'subtract', 'common', 'plane', 'text',
    ];
    for (const type of rowTypes) {
      expect(registry.editsRowType(type), type).toBe(true);
    }
    for (const type of ['shell', 'fillet', 'chamfer', 'offset', 'fillet2d', 'projection', 'intersect', 'slot', 'sketch']) {
      expect(registry.editsRowType(type), type).toBe(false);
    }
    const kinds: [ParsedFeatureStatement['feature'], PartId][] = [
      ['extrude', 'extrude'], ['rib', 'rib'], ['hole', 'hole'], ['revolve', 'revolve'], ['sweep', 'sweep'],
      ['wrap', 'wrap'], ['loft', 'loft'], ['helix', 'helix'], ['repeat', 'repeat'], ['copy', 'copy'],
      ['mirror', 'mirror'], ['rotate', 'rotate'], ['connector', 'connector'], ['boolean', 'boolean'],
      ['plane', 'plane'], ['text', 'text'],
    ];
    for (const [kind, id] of kinds) {
      const dialog = registry.forParsedFeature(kind);
      expect(dialog?.id, kind).toBe(id);
      const parsed = { feature: kind } as ParsedFeatureStatement;
      dialog!.enterEdit!(TARGET, parsed, INFO, ROW);
      expect(fakes[id].edits.at(-1)!.slice(0, 3), kind).toEqual([TARGET, parsed, INFO]);
    }
    for (const kind of ['shell', 'fillet', 'chamfer', 'offset', 'project', 'slot', 'sketch'] as const) {
      expect(registry.forParsedFeature(kind), kind).toBeNull();
    }
  });

  it("opens a connector edit with the frame its row carries, or none for a failed build", () => {
    const dialog = registry.forParsedFeature('connector')!;
    const parsed = { feature: 'connector' } as ParsedFeatureStatement;
    const v = { x: 0, y: 0, z: 1 };
    const frame = { name: 'c', origin: v, xDirection: v, yDirection: v, normal: v };
    dialog.enterEdit!(TARGET, parsed, INFO, { type: 'connector', object: frame } as unknown as SceneObjectRender);
    dialog.enterEdit!(TARGET, parsed, INFO, { type: 'connector', object: { name: 'c' } } as unknown as SceneObjectRender);
    expect(fakes.connector.edits.map((args) => args[3])).toEqual([frame, null]);
  });

  it("ends the text dialog's session with the editEnd Continue asks for", () => {
    arm('text');
    registry.continueEdits();
    expect(fakes.text.calls).toEqual(['exit:continue']);
    arm('text');
    fakes.text.calls = [];
    registry.exitAll();
    expect(fakes.text.calls).toEqual(['exit']);
  });
});

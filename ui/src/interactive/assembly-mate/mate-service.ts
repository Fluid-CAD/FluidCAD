import { MatePanel, MateSlotKey } from './mate-panel';
import {
  applyAssemblyMate,
  classifyContactPick,
  AssemblyMateGeometryRef,
  AssemblyMateOptions,
  AssemblyMateType,
} from '../../api';
import type { Viewer } from '../../viewer';
import type { SerializedAssembly, SerializedAssemblyMate, SubSelection } from '../../types';
import type { ContactEntity, MateRecord } from '../../solver';
import { contactChainsRowCount } from '../../solver/contact-model';

/**
 * One picked connector: the live scene ids (refreshed per render — the
 * renderer re-mints them) plus the stable source address the statement is
 * written against and the picks re-resolve by.
 */
type MateSlotState = {
  instanceId: string;
  connectorId: string;
  /** 1-based row of the instance's `insert()` chain (its sourceLocation). */
  instanceLine: number;
  connectorName: string;
  instanceName: string;
  /** The assembly file the insert() lives in — the mate's target file. */
  filePath: string;
};

/**
 * One picked face/edge for a TANGENT mate: the stable instance address
 * plus the classify-route result. `exposeName` is the exposure that
 * already serves the pick, or null — Apply then find-or-creates one from
 * `pick` (which is only render-stable for the current scene; a re-render
 * drops unmatched chips, see handleSceneRendered).
 */
type TangentSlotState = {
  instanceId: string;
  instanceLine: number;
  instanceName: string;
  filePath: string;
  exposeName: string | null;
  pick: { shapeId: string; sub: { type: 'face' | 'edge'; index: number } };
  seed: ContactEntity;
  chain: ContactEntity[];
};

/** The provisional record's id — never collides with `mate-<n>` scene ids. */
const PREVIEW_MATE_ID = '__mate-preview__';

/**
 * The mate statement an open dialog is editing: its stable source address
 * (what Apply rewrites) plus the committed record's id in the current
 * render — the provisional preview reuses that id so the solver swaps the
 * committed mate out instead of fighting it. Renders re-mint mate ids, so
 * {@link AssemblyMateService.handleSceneRendered} refreshes `mateId` (and
 * drops the whole session when the statement is gone).
 */
type MateEditTarget = {
  filePath: string;
  /** 1-based row the `mate()` statement starts on (its sourceLocation). */
  sourceLine: number;
  mateId: string;
};

/**
 * The assembly mate tool: a toolbar mate button opens the {@link MatePanel}
 * with that type preselected, connector picking armed (all gizmos revealed,
 * instance drags suppressed), and picks filling Connector A then B. With
 * both slots filled the candidate mate is solved live as a provisional
 * record — the parts pull together while the dialog is open, and snap back
 * if it closes without applying. Apply writes the `mate()` statement through
 * `/api/assembly-mate`; the render it triggers shows the committed joint.
 *
 * The joints panel's "Edit mate" opens the same dialog seeded from an
 * existing statement ({@link beginEdit}): slots pre-filled from the record,
 * re-picking live, the provisional preview REPLACING the committed mate in
 * the solve, and Apply re-rendering the statement in place.
 */
export class AssemblyMateService {
  private panel: MatePanel;
  private armed = false;
  private applying = false;
  private editTarget: MateEditTarget | null = null;
  private slots: Record<MateSlotKey, MateSlotState | null> = { a: null, b: null };
  /** Tangent picks fill these instead — the two side kinds never mix. */
  private tangentSlots: Record<MateSlotKey, TangentSlotState | null> = { a: null, b: null };

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private hooks: {
      getAssembly: () => SerializedAssembly | null;
      /** The dialog opened — dismiss the transform gizmo / viewport selection. */
      onEnter?: () => void;
      onExit?: () => void;
      /** A picked chip's pen — open the connector property editor beside us. */
      onEditConnector?: (state: MateSlotState) => void;
    },
  ) {
    this.panel = new MatePanel(container);
    this.panel.onApply = () => void this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshPreview();
    };
    this.panel.onRemoveConnector = (slot) => {
      this.slots[slot] = null;
      this.tangentSlots[slot] = null;
      this.panel.setSlotChip(slot, null);
      this.panel.armSlot(slot);
      this.panel.setMessage(null);
      this.refreshPreview();
    };
    this.panel.onEditConnector = (slot) => {
      const state = this.slots[slot];
      if (state) {
        this.hooks.onEditConnector?.(state);
      }
    };
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** The armed dialog owns viewport clicks in assembly mode. */
  get isPicking(): boolean {
    return this.armed;
  }

  /**
   * A toolbar mate button: open the dialog armed for picking with the given
   * type, or — already open in create mode — just switch the type dropdown.
   * An open edit session ends first (snapping its preview back): the toolbar
   * means "create a NEW mate", not "retype the one being edited".
   */
  enter(type: AssemblyMateType): void {
    if (this.armed) {
      if (!this.editTarget) {
        // Switching between the connector-authored types keeps the picks;
        // crossing the tangent boundary can't — the side kinds differ.
        const wasTangent = this.panel.getType() === 'tangent';
        const isTangent = type === 'tangent';
        if (wasTangent !== isTangent) {
          this.slots = { a: null, b: null };
          this.tangentSlots = { a: null, b: null };
          this.panel.setSlotChip('a', null);
          this.panel.setSlotChip('b', null);
          this.panel.armSlot('a');
        }
        this.panel.setType(type);
        this.syncViewport();
        this.refreshPreview();
        return;
      }
      this.exit();
    }
    this.armed = true;
    this.slots = { a: null, b: null };
    this.tangentSlots = { a: null, b: null };
    this.panel.show(type);
    this.syncViewport();
    this.hooks.onEnter?.();
    this.refreshPreview();
  }

  /**
   * The joints panel's "Edit mate": open the dialog seeded from the mate's
   * serialized record — type and options into the form, both connectors as
   * picked chips (re-resolved to live scene ids), the statement's source
   * address as the Apply target. A slot whose connector no longer resolves
   * opens empty with the reason shown; picking refills it like create mode.
   */
  beginEdit(mate: SerializedAssemblyMate): void {
    if (this.applying) {
      return;
    }
    const location = mate.sourceLocation;
    if (!location || mate.owner) {
      return; // owned mates edit in their own file — the menu already gates this
    }
    if (this.armed) {
      this.exit();
    }
    this.armed = true;
    this.editTarget = {
      filePath: location.filePath,
      sourceLine: location.line,
      mateId: mate.mateId,
    };
    this.slots = { a: null, b: null };
    this.tangentSlots = { a: null, b: null };
    this.panel.show(mate.type, mate.options ?? {});
    let problem: string | null = null;
    if (mate.type === 'tangent') {
      for (const key of ['a', 'b'] as const) {
        const side = key === 'a' ? mate.geometryA : mate.geometryB;
        if (!side) {
          problem = problem ?? 'This mate has no geometry sides — re-render and try again.';
          continue;
        }
        const state = this.resolveExposureSide(side.instanceId, side.exposeName);
        if ('error' in state) {
          problem = problem ?? state.error;
          continue;
        }
        this.tangentSlots[key] = state;
        this.panel.setSlotChip(key, tangentChipLabel(state));
      }
      if (this.tangentSlots.a && !this.tangentSlots.b) {
        this.panel.armSlot('b');
      }
    } else {
      for (const key of ['a', 'b'] as const) {
        const side = key === 'a' ? mate.connectorA : mate.connectorB;
        if (!side) {
          problem = problem ?? 'This mate has no connector sides — re-render and try again.';
          continue;
        }
        const state = this.resolvePick(side.connectorId, side.instanceId);
        if ('error' in state) {
          problem = problem ?? state.error;
          continue;
        }
        this.slots[key] = state;
        this.panel.setSlotChip(key, `${state.instanceName} · ${state.connectorName}`);
      }
      // show() armed slot A; aim picks at the first EMPTY slot instead when
      // exactly one side failed to resolve.
      if (this.slots.a && !this.slots.b) {
        this.panel.armSlot('b');
      }
    }
    this.panel.setMessage(problem);
    this.syncViewport();
    this.hooks.onEnter?.();
    this.refreshPreview();
  }

  exit(): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.editTarget = null;
    this.slots = { a: null, b: null };
    this.tangentSlots = { a: null, b: null };
    this.syncViewport();
    this.panel.hide();
    this.hooks.onExit?.();
  }

  /**
   * Routes viewport clicks while armed. A connector pick fills the armed
   * slot (and hands the armed border to the other slot when it's still
   * empty); mates reference existing part connectors only, so a bare
   * face/edge pick just points at the Connector tool.
   */
  handleClick(shapeId: string | null, sub: SubSelection, instanceId: string | null): void {
    if (!this.armed) {
      return;
    }
    if (!shapeId || !sub) {
      return; // empty-space click keeps the picks (misclicks shouldn't wipe them)
    }
    if (this.panel.getType() === 'tangent') {
      if (sub.type === 'face' || sub.type === 'edge') {
        void this.handleTangentPick(shapeId, sub, instanceId);
      }
      return;
    }
    if (sub.type !== 'connector') {
      if (sub.type === 'face' || sub.type === 'edge') {
        this.panel.setMessage(
          'Mates connect existing connectors — click a connector gizmo, or add one to the part with the Connector tool first.',
        );
      }
      return;
    }
    const state = this.resolvePick(shapeId, instanceId);
    if ('error' in state) {
      this.panel.setMessage(state.error);
      return;
    }
    const slot = this.panel.getArmedSlot();
    const other: MateSlotKey = slot === 'a' ? 'b' : 'a';
    if (this.sameConnector(this.slots[other], state)) {
      this.panel.setMessage('A connector cannot be mated to itself — pick a different one.');
      return;
    }
    this.slots[slot] = state;
    this.panel.setSlotChip(slot, `${state.instanceName} · ${state.connectorName}`);
    this.panel.setMessage(null);
    if (!this.slots[other]) {
      this.panel.armSlot(other);
    }
    this.refreshPreview();
  }

  /**
   * A tangent-mode face/edge pick: classify it through the server
   * (attribution → donor part + exposure find-or-create data + canonical
   * contact geometry), refuse unsupported forms with the pointed message,
   * and stage the chip. The dialog stays responsive — the route runs
   * against the already-rendered scene.
   */
  private async handleTangentPick(
    shapeId: string,
    sub: { type: 'face' | 'edge'; index: number },
    instanceId: string | null,
  ): Promise<void> {
    const assembly = this.hooks.getAssembly();
    const instance = instanceId
      ? assembly?.instances.find(i => i.instanceId === instanceId)
      : undefined;
    if (!instance) {
      this.panel.setMessage('Could not resolve the pick to an instance — try re-rendering.');
      return;
    }
    if (!instance.sourceLocation) {
      this.panel.setMessage(`${instance.name} has no source location — its insert() cannot be referenced.`);
      return;
    }
    const pick = { shapeId, sub: { type: sub.type, index: sub.index } };
    const result = await classifyContactPick(pick);
    if (!this.armed || this.panel.getType() !== 'tangent') {
      return; // the dialog moved on while the route ran
    }
    if ('error' in result) {
      this.panel.setMessage(result.error);
      return;
    }
    if (!result.donor) {
      this.panel.setMessage('The picked geometry lies outside any part() — tangent mates reference part-owned geometry.');
      return;
    }
    if (!result.seed) {
      this.panel.setMessage(
        "Tangent between these surface types isn't supported yet — supported: plane, cylinder, sphere, cone faces; line/circle edges.",
      );
      return;
    }
    const state: TangentSlotState = {
      instanceId: instance.instanceId,
      instanceLine: instance.sourceLocation.line,
      instanceName: instance.name,
      filePath: instance.sourceLocation.filePath,
      exposeName: result.donor.matched,
      pick,
      seed: result.seed,
      chain: result.chain,
    };
    const slot = this.panel.getArmedSlot();
    const other: MateSlotKey = slot === 'a' ? 'b' : 'a';
    const existing = this.tangentSlots[other];
    if (existing && existing.instanceId === state.instanceId
      && existing.pick.shapeId === state.pick.shapeId
      && existing.pick.sub.type === state.pick.sub.type
      && existing.pick.sub.index === state.pick.sub.index) {
      this.panel.setMessage('Geometry cannot be mated to itself — pick a different face or edge.');
      return;
    }
    this.tangentSlots[slot] = state;
    this.panel.setSlotChip(slot, tangentChipLabel(state));
    this.panel.setMessage(null);
    if (pick.sub.type === 'face') {
      this.viewer.highlightFace(pick.shapeId, pick.sub.index, state.instanceId);
    } else {
      this.viewer.highlightEdge(pick.shapeId, pick.sub.index, state.instanceId);
    }
    if (!this.tangentSlots[other]) {
      this.panel.armSlot(other);
    }
    this.refreshPreview();
  }

  /**
   * Resolve a committed tangent side ({instanceId, exposeName}) back to a
   * live chip: the instance's stable address plus the exposure's published
   * classification from the current render.
   */
  private resolveExposureSide(
    instanceId: string,
    exposeName: string,
  ): TangentSlotState | { error: string } {
    const assembly = this.hooks.getAssembly();
    const instance = assembly?.instances.find(i => i.instanceId === instanceId);
    if (!instance) {
      return { error: 'Could not resolve the mate side to an instance — try re-rendering.' };
    }
    if (!instance.sourceLocation) {
      return { error: `${instance.name} has no source location — its insert() cannot be referenced.` };
    }
    const contact = this.viewer.getAssemblyController()?.getContactState(instanceId, exposeName);
    if (!contact) {
      return { error: `${instance.name} no longer publishes expose('${exposeName}') — re-pick the geometry.` };
    }
    if (!contact.seed) {
      return { error: `expose('${exposeName}') serves an unsupported surface form — re-pick the geometry.` };
    }
    return {
      instanceId,
      instanceLine: instance.sourceLocation.line,
      instanceName: instance.name,
      filePath: instance.sourceLocation.filePath,
      exposeName,
      // A matched side never needs its pick again (Apply references the
      // exposure by name); a placeholder ref keeps the type simple.
      pick: { shapeId: '', sub: { type: 'face', index: 0 } },
      seed: contact.seed,
      chain: contact.chain,
    };
  }

  /**
   * Every assembly render lands here: scene ids were re-minted, so each pick
   * re-resolves through its stable (instance line, connector name) address —
   * a pick whose statement is gone drops back to the prompt. A render that
   * switched to a part scene closes the dialog, and so does an edit session
   * whose `mate()` statement no longer starts on the edited line (deleted,
   * or shifted by a source edit — rewriting a moved line risks splicing the
   * wrong statement).
   */
  handleSceneRendered(sceneKind: 'part' | 'assembly'): void {
    if (!this.armed) {
      return;
    }
    if (sceneKind !== 'assembly') {
      this.exit();
      return;
    }
    if (this.editTarget) {
      const fresh = this.hooks.getAssembly()?.mates.find(m =>
        m.sourceLocation?.filePath === this.editTarget!.filePath
        && m.sourceLocation.line === this.editTarget!.sourceLine
        && !m.owner,
      );
      if (!fresh) {
        this.exit();
        return;
      }
      // The committed record's id was re-minted with the render; the preview
      // must keep replacing the RIGHT mate in the solve.
      this.editTarget.mateId = fresh.mateId;
    }
    // The controller rebuilt its groups — re-assert pick arming on it.
    this.syncViewport();
    for (const key of ['a', 'b'] as const) {
      const state = this.slots[key];
      if (!state) continue;
      const fresh = this.reresolve(state);
      this.slots[key] = fresh;
      if (!fresh) {
        this.panel.setSlotChip(key, null);
      }
    }
    let tangentDropped = false;
    for (const key of ['a', 'b'] as const) {
      const state = this.tangentSlots[key];
      if (!state) continue;
      if (state.exposeName) {
        // Matched sides carry a stable address (instance line + exposure
        // name) — re-resolve against the fresh render's ids and geometry.
        const instance = this.hooks.getAssembly()?.instances.find(
          i => i.sourceLocation?.line === state.instanceLine
            && i.sourceLocation?.filePath === state.filePath,
        );
        const fresh = instance
          ? this.resolveExposureSide(instance.instanceId, state.exposeName)
          : null;
        if (fresh && !('error' in fresh)) {
          this.tangentSlots[key] = fresh;
          this.panel.setSlotChip(key, tangentChipLabel(fresh));
          continue;
        }
      }
      // Unmatched picks have no stable address across a render (scene ids
      // are re-minted) — drop the chip rather than pointing at the wrong
      // face.
      this.tangentSlots[key] = null;
      this.panel.setSlotChip(key, null);
      tangentDropped = true;
    }
    if (tangentDropped) {
      this.panel.setMessage('The scene re-rendered — re-pick the dropped face/edge.');
    }
    this.refreshPreview();
  }

  /**
   * Arm/disarm the viewer channel + controller reveal for the current
   * state. Create mode reveals every connector (the user is scanning for
   * two); edit mode reveals on hover — only the mate's own picked
   * connectors stay pinned in view. With no dialog open connectors never
   * show, hover included.
   */
  private syncViewport(): void {
    const tangent = this.armed && this.panel.getType() === 'tangent';
    // Tangent picks are plain face/edge raycasts — the connector channel
    // (and its gizmo reveal) stays off; setMatePicking still suppresses
    // the drag-vs-pick ambiguity while the dialog is armed.
    this.viewer.pickConnectors = this.armed && !tangent;
    const controller = this.viewer.getAssemblyController();
    controller?.setMatePicking(this.armed, this.editTarget === null && !tangent);
    if (!this.armed) {
      controller?.setProvisionalMate(null);
    }
  }

  /** A clicked connector gizmo → the slot state, or the reason it can't be used. */
  private resolvePick(
    connectorId: string,
    instanceId: string | null,
  ): MateSlotState | { error: string } {
    const assembly = this.hooks.getAssembly();
    const instance = instanceId
      ? assembly?.instances.find(i => i.instanceId === instanceId)
      : undefined;
    if (!instance) {
      return { error: 'Could not resolve the connector to an instance — try re-rendering.' };
    }
    if (!instance.sourceLocation) {
      return { error: `${instance.name} has no source location — its insert() cannot be referenced.` };
    }
    const controller = this.viewer.getAssemblyController();
    const name = controller?.getConnectorName(connectorId);
    if (!name) {
      return { error: 'This connector has no name — its statement failed to build.' };
    }
    return {
      instanceId: instance.instanceId,
      connectorId,
      instanceLine: instance.sourceLocation.line,
      connectorName: name,
      instanceName: instance.name,
      filePath: instance.sourceLocation.filePath,
    };
  }

  /** Re-resolve a pick against the fresh render's ids; null when gone. */
  private reresolve(state: MateSlotState): MateSlotState | null {
    const assembly = this.hooks.getAssembly();
    const controller = this.viewer.getAssemblyController();
    if (!assembly || !controller) {
      return null;
    }
    const instance = assembly.instances.find(
      i => i.sourceLocation?.line === state.instanceLine
        && i.sourceLocation?.filePath === state.filePath,
    );
    if (!instance || !instance.sourceLocation) {
      return null;
    }
    const connectorId = controller.findConnectorId(instance.instanceId, state.connectorName);
    if (!connectorId) {
      return null;
    }
    return {
      ...state,
      instanceId: instance.instanceId,
      connectorId,
      instanceName: instance.name,
    };
  }

  private sameConnector(a: MateSlotState | null, b: MateSlotState): boolean {
    return a !== null
      && a.instanceLine === b.instanceLine
      && a.connectorName === b.connectorName;
  }

  /**
   * The pen-button editor renamed a picked connector in its part file:
   * re-point the slot at the new name so the pending render's re-resolve
   * (which matches by name) doesn't drop the pick.
   */
  noteConnectorRenamed(slot: MateSlotState, newName: string): void {
    for (const key of ['a', 'b'] as const) {
      const state = this.slots[key];
      if (!state || state !== slot) continue;
      state.connectorName = newName;
      this.panel.setSlotChip(key, `${state.instanceName} · ${newName}`);
    }
    this.refreshPreview();
  }

  /**
   * A referenced connector's `insert()` must live in the file the statement
   * is written to — its line number is meaningless in any other file. Create
   * mode targets the first pick's file; edit mode targets the statement's.
   */
  private crossFileConflict(): string | null {
    const tangent = this.panel.getType() === 'tangent';
    const a = tangent ? this.tangentSlots.a : this.slots.a;
    const b = tangent ? this.tangentSlots.b : this.slots.b;
    const what = tangent ? 'geometry' : 'a connector';
    if (this.editTarget) {
      for (const state of [a, b]) {
        if (state && state.filePath !== this.editTarget.filePath) {
          return `${state.instanceName} is inserted by a different file than this mate — pick ${what} from an instance of the mate's own file.`;
        }
      }
      return null;
    }
    if (a && b && a.filePath !== b.filePath) {
      return `The two picks are inserted by different files — mate them in the file that inserts both.`;
    }
    return null;
  }

  /**
   * Sync the statement preview row, the Apply button, and the live solver
   * preview to the current picks + options.
   */
  private refreshPreview(): void {
    if (!this.armed) {
      return;
    }
    // Picked connectors render opaque while the rest stay translucent (and
    // pinned per instance in the edit dialog's hover-reveal) — re-sent
    // every refresh because renders re-mint the scene ids.
    this.viewer.getAssemblyController()?.setMatePickedConnectors(
      [this.slots.a, this.slots.b]
        .filter((s): s is MateSlotState => s !== null)
        .map(s => ({ instanceId: s.instanceId, connectorId: s.connectorId })),
    );
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      this.panel.setApplyEnabled(false);
      this.viewer.getAssemblyController()?.setProvisionalMate(null);
      return;
    }
    if (values.type === 'tangent') {
      this.refreshTangentPreview(values.propagate);
      return;
    }
    const a = this.slots.a;
    const b = this.slots.b;
    const ref = (s: MateSlotState | null) =>
      s ? `${s.instanceName}.connectors.${s.connectorName}` : '…';
    let chain = `mate('${values.type}', ${ref(a)}, ${ref(b)})`;
    if (values.flip) chain += '.flip()';
    if (values.rotate !== 0) chain += `.rotate(${values.rotate})`;
    if (values.offset.some(n => n !== 0)) chain += `.offset(${values.offset.join(', ')})`;
    if (values.limits) chain += `.limits(${values.limits.join(', ')})`;
    this.panel.setPreview(`${chain};`);
    const conflict = this.crossFileConflict();
    if (conflict) {
      this.panel.setMessage(conflict);
    }
    this.panel.setApplyEnabled(a !== null && b !== null && conflict === null && !this.applying);

    const controller = this.viewer.getAssemblyController();
    if (a && b && conflict === null && controller) {
      const record: MateRecord = {
        // Edit sessions reuse the committed record's id: the controller
        // solves the provisional record INSTEAD of the mate it replaces.
        mateId: this.editTarget?.mateId ?? PREVIEW_MATE_ID,
        type: values.type,
        connectorA: { instanceId: a.instanceId, connectorId: a.connectorId },
        connectorB: { instanceId: b.instanceId, connectorId: b.connectorId },
        options: {
          ...(values.flip ? { flip: true } : {}),
          ...(values.rotate !== 0 ? { rotate: values.rotate } : {}),
          ...(values.offset.some(n => n !== 0) ? { offset: values.offset } : {}),
          ...(values.limits ? { limits: values.limits } : {}),
        },
      };
      controller.setProvisionalMate(record);
    } else {
      controller?.setProvisionalMate(null);
    }
  }

  /**
   * The tangent preview: statement row (`instance.features.<name>` refs, a
   * muted placeholder for still-to-create exposures), Tier-1 pair
   * validation from the classify results, and the provisional record with
   * INLINE contact data — the solve runs before any expose() exists.
   */
  private refreshTangentPreview(propagate: boolean): void {
    const a = this.tangentSlots.a;
    const b = this.tangentSlots.b;
    const ref = (s: TangentSlotState | null) =>
      s ? `${s.instanceName}.features.${s.exposeName ?? 'new'}` : '…';
    let chain = `mate('tangent', ${ref(a)}, ${ref(b)})`;
    if (!propagate) chain += '.noPropagate()';
    this.panel.setPreview(`${chain};`);

    const effectiveChain = (s: TangentSlotState) =>
      propagate && s.chain.length > 0 ? s.chain : [s.seed];
    const pairOk = !a || !b
      || contactChainsRowCount(effectiveChain(a), effectiveChain(b)) > 0;
    const conflict = this.crossFileConflict();
    if (conflict) {
      this.panel.setMessage(conflict);
    } else if (!pairOk) {
      this.panel.setMessage(
        `A ${a!.seed.form} can't be mated tangent to a ${b!.seed.form}`
        + (a!.seed.form === 'plane' && b!.seed.form === 'plane' ? ' — use a planar mate.'
          : !a!.seed.convex && !b!.seed.convex ? ' — two hollow (concave) surfaces never touch.'
            : ' with these shapes.'),
      );
    }
    this.panel.setApplyEnabled(
      a !== null && b !== null && conflict === null && pairOk && !this.applying,
    );

    const controller = this.viewer.getAssemblyController();
    if (a && b && conflict === null && pairOk && controller) {
      controller.setProvisionalMate({
        mateId: this.editTarget?.mateId ?? PREVIEW_MATE_ID,
        type: 'tangent',
        geometryA: {
          instanceId: a.instanceId,
          exposeName: a.exposeName ?? '__pick__',
          seed: a.seed,
          chain: a.chain,
        },
        geometryB: {
          instanceId: b.instanceId,
          exposeName: b.exposeName ?? '__pick__',
          seed: b.seed,
          chain: b.chain,
        },
        options: propagate ? {} : { propagate: false },
      });
    } else {
      controller?.setProvisionalMate(null);
    }
  }

  private async apply(): Promise<void> {
    if (this.panel.getType() === 'tangent') {
      await this.applyTangent();
      return;
    }
    const a = this.slots.a;
    const b = this.slots.b;
    if (!a || !b || this.applying) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      return;
    }
    // Enter in an option field submits past a disabled Apply button —
    // re-check the pick constraint the button encodes.
    const conflict = this.crossFileConflict();
    if (conflict) {
      this.panel.setMessage(conflict);
      return;
    }
    const options: AssemblyMateOptions = {
      flip: values.flip,
      rotate: values.rotate,
      offset: values.offset,
      limits: values.limits,
    };
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const sideRef = (s: MateSlotState) => ({
        instanceLine: s.instanceLine,
        connectorName: s.connectorName,
      });
      const target = this.editTarget;
      const payload = {
        type: values.type,
        connectorA: sideRef(a),
        connectorB: sideRef(b),
        options,
      };
      const result = await applyAssemblyMate(
        target?.filePath ?? a.filePath,
        target ? { edit: { sourceLine: target.sourceLine, ...payload } } : { create: payload },
      );
      if (!result.success) {
        this.panel.setMessage(
          result.reason ?? (target ? 'Could not update the mate.' : 'Could not add the mate.'),
        );
        this.panel.setApplyEnabled(true);
        return;
      }
      // The committed statement re-renders with the real mate; drop the
      // provisional record (so it can't double-solve) but keep its poses on
      // screen — exit()'s setProvisionalMate(null) is then a no-op, and the
      // parts hold the preview pose instead of snapping back while the
      // render is in flight.
      this.viewer.getAssemblyController()?.commitProvisionalMate();
      this.exit();
    } finally {
      this.applying = false;
    }
  }

  /**
   * Tangent Apply: geometry sides reference matched exposures by name;
   * unmatched sides send their raw pick and the server find-or-creates the
   * expose() (same-file donors fold atomically into the mate transform,
   * cross-file donors are dispatched first — §7.2 sequencing).
   */
  private async applyTangent(): Promise<void> {
    const a = this.tangentSlots.a;
    const b = this.tangentSlots.b;
    if (!a || !b || this.applying) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      return;
    }
    const conflict = this.crossFileConflict();
    if (conflict) {
      this.panel.setMessage(conflict);
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const sideRef = (s: TangentSlotState): AssemblyMateGeometryRef => ({
        instanceLine: s.instanceLine,
        ...(s.exposeName ? { exposeName: s.exposeName } : { pick: s.pick }),
      });
      const target = this.editTarget;
      const payload = {
        type: 'tangent' as const,
        geometryA: sideRef(a),
        geometryB: sideRef(b),
        options: values.propagate === false ? { propagate: false } : {},
      };
      const result = await applyAssemblyMate(
        target?.filePath ?? a.filePath,
        target ? { edit: { sourceLine: target.sourceLine, ...payload } } : { create: payload },
      );
      if (!result.success) {
        this.panel.setMessage(
          result.reason ?? (target ? 'Could not update the mate.' : 'Could not add the mate.'),
        );
        this.panel.setApplyEnabled(true);
        return;
      }
      this.viewer.getAssemblyController()?.commitProvisionalMate();
      this.exit();
    } finally {
      this.applying = false;
    }
  }
}

/** `Cam · cylinder` (+ ` · new` while the exposure is still to be created). */
function tangentChipLabel(state: TangentSlotState): string {
  return `${state.instanceName} · ${state.seed.form}${state.exposeName ? '' : ' · new'}`;
}

export type { MateSlotState };

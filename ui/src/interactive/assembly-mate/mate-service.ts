import { MatePanel, MateSlotKey } from './mate-panel';
import { ConnectorPickMenu } from './connector-pick-menu';
import {
  applyAssemblyMate,
  classifyContactPick,
  AssemblyMateConnectorRef,
  AssemblyMateGeometryRef,
  AssemblyMateOptions,
  AssemblyMateType,
} from '../../api';
import type { Viewer } from '../../viewer';
import type { SerializedAssembly, SerializedAssemblyMate, SubSelection } from '../../types';
import type { SelectionModifiers } from '../../viewer';
import type { ContactEntity, MateRecord } from '../../solver';
import { WORLD_BODY_ID, worldConnectorRef } from '../../solver';
import { contactChainsRowCount } from '../../solver/contact-model';

import {
  connectorChipLabel,
  connectorRefFor,
  findInstanceByAddress,
  previewConnectorRef,
  reresolveSlot,
  resolveConnectorPick,
  resolveSideChain,
  resolveWorldPick,
  sameConnectorSlot,
  worldChipLabel,
  type ConnectorSlotState,
  type MateSlotState,
  type ResolvedSideChain,
  type WorldSlotState,
} from './side-resolve';

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
  /** The instance is a replica: its address is the replicate() line + this row. */
  replicaRow?: number;
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
  private pickMenu: ConnectorPickMenu;
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
      onEditConnector?: (state: ConnectorSlotState) => void;
      /** An assembly-connector chip's pen — open the assembly connector dialog on it. */
      onEditWorldConnector?: (state: WorldSlotState) => void;
    },
  ) {
    this.panel = new MatePanel(container);
    this.pickMenu = new ConnectorPickMenu(container);
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
      if (state?.kind === 'connector') {
        this.hooks.onEditConnector?.(state);
      } else if (state?.kind === 'world') {
        this.hooks.onEditWorldConnector?.(state);
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
        const frame = key === 'a' ? mate.frameA : mate.frameB;
        if (frame) {
          const state = this.resolveWorldPick(frame.connectorId);
          if ('error' in state) {
            problem = problem ?? state.error;
            continue;
          }
          this.slots[key] = state;
          this.panel.setSlotChip(key, worldChipLabel(state), { pen: this.hooks.onEditWorldConnector !== undefined });
          continue;
        }
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
        this.panel.setSlotChip(key, connectorChipLabel(state));
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
    this.pickMenu.close();
    this.syncViewport();
    this.panel.hide();
    this.hooks.onExit?.();
  }

  /**
   * Routes viewport clicks while armed. A connector pick fills the armed
   * slot (and hands the armed border to the other slot when it's still
   * empty); several gizmos under the cursor open a "which connector?"
   * popover first. Mates reference existing part connectors only, so a
   * bare face/edge pick just points at the Connector tool.
   */
  handleClick(
    shapeId: string | null,
    sub: SubSelection,
    instanceId: string | null,
    pick?: Pick<SelectionModifiers, 'clientX' | 'clientY' | 'connectorCandidates'>,
  ): void {
    if (!this.armed) {
      return;
    }
    this.pickMenu.close();
    if (!shapeId || !sub) {
      return; // empty-space click keeps the picks (misclicks shouldn't wipe them)
    }
    const candidates = pick?.connectorCandidates;
    if (
      sub.type === 'connector' && candidates && candidates.length > 1
      && pick?.clientX !== undefined && pick.clientY !== undefined
      && this.panel.getType() !== 'tangent'
    ) {
      this.openPickMenu(candidates, pick.clientX, pick.clientY);
      return;
    }
    this.pickConnectorSide(shapeId, sub, instanceId);
  }

  /**
   * A row click in the rail's Connectors section while picking: the
   * assembly connector fills the armed slot — no gizmo to hunt for under a
   * coincident part connector, and hidden connectors stay reachable.
   */
  pickWorldConnector(connectorId: string): void {
    if (!this.armed) {
      return;
    }
    this.pickMenu.close();
    if (this.panel.getType() === 'tangent') {
      this.panel.setMessage('Tangent mates take exposed faces/edges — pick geometry in the viewport instead.');
      return;
    }
    this.pickConnectorSide(connectorId, { type: 'connector', index: 0 }, WORLD_BODY_ID);
  }

  /** The popover listing every connector under an ambiguous click. */
  private openPickMenu(
    candidates: { instanceId: string; connectorId: string }[],
    clientX: number,
    clientY: number,
  ): void {
    const controller = this.viewer.getAssemblyController();
    const items = candidates.map((candidate) => ({
      label: this.candidateLabel(candidate),
      onHover: () => controller?.setHighlightedConnector(candidate.connectorId),
      onPick: () => this.pickConnectorSide(candidate.connectorId, { type: 'connector', index: 0 }, candidate.instanceId),
    }));
    this.pickMenu.show(clientX, clientY, items, () => controller?.setHighlightedConnector(null));
  }

  /** `Crank Shaft · shaft` / `Assembly · origin` — the chip label the pick would carry. */
  private candidateLabel(candidate: { instanceId: string; connectorId: string }): string {
    if (candidate.instanceId === WORLD_BODY_ID) {
      const state = this.resolveWorldPick(candidate.connectorId);
      return 'error' in state ? `Assembly · ${candidate.connectorId}` : worldChipLabel(state);
    }
    const state = this.resolvePick(candidate.connectorId, candidate.instanceId);
    if ('error' in state) {
      const instance = this.hooks.getAssembly()?.instances.find(i => i.instanceId === candidate.instanceId);
      return `${instance?.name ?? candidate.instanceId} · ${this.viewer.getAssemblyController()?.getConnectorName(candidate.connectorId) ?? '?'}`;
    }
    return connectorChipLabel(state);
  }

  /** One resolved connector (part or assembly) into the armed slot. */
  private pickConnectorSide(shapeId: string, sub: SubSelection, instanceId: string | null): void {
    if (!this.armed || !sub) {
      return;
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
    const slot = this.panel.getArmedSlot();
    const other: MateSlotKey = slot === 'a' ? 'b' : 'a';
    // An assembly connector's gizmo: fills the slot with that frame (its
    // binding in the statement).
    if (instanceId === WORLD_BODY_ID) {
      if (this.slots[other]?.kind === 'world') {
        this.panel.setMessage('One side must be a part connector — two assembly connectors cannot be mated together.');
        return;
      }
      const state = this.resolveWorldPick(shapeId);
      if ('error' in state) {
        this.panel.setMessage(state.error);
        return;
      }
      this.slots[slot] = state;
      this.panel.setSlotChip(slot, worldChipLabel(state), { pen: this.hooks.onEditWorldConnector !== undefined });
      this.panel.setMessage(null);
      if (!this.slots[other]) {
        this.panel.armSlot(other);
      }
      this.refreshPreview();
      return;
    }
    const state = this.resolvePick(shapeId, instanceId);
    if ('error' in state) {
      this.panel.setMessage(state.error);
      return;
    }
    if (this.sameConnector(this.slots[other], state)) {
      this.panel.setMessage('A connector cannot be mated to itself — pick a different one.');
      return;
    }
    this.slots[slot] = state;
    this.panel.setSlotChip(slot, connectorChipLabel(state));
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
    if (instance.owner) {
      this.panel.setMessage(
        `${instance.name} lives inside a sub-assembly — tangent mates can't reach through .parts yet; open the sub-assembly's own file to mate there.`,
      );
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
      ...(instance.replica ? { replicaRow: instance.replica.row } : {}),
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
    if (instance.owner) {
      return { error: `${instance.name} lives inside a sub-assembly — tangent mates can't reach through .parts yet.` };
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
      ...(instance.replica ? { replicaRow: instance.replica.row } : {}),
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
        const assembly = this.hooks.getAssembly();
        const instance = assembly
          ? findInstanceByAddress(assembly, { ...state, owner: '' })
          : undefined;
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
  ): ConnectorSlotState | { error: string } {
    return resolveConnectorPick(this.hooks.getAssembly(), this.viewer.getAssemblyController(), connectorId, instanceId);
  }

  /** A clicked assembly-connector gizmo → the slot state, or why it can't be used. */
  private resolveWorldPick(connectorId: string): WorldSlotState | { error: string } {
    return resolveWorldPick(this.hooks.getAssembly(), connectorId);
  }

  /** Re-resolve a pick against the fresh render's ids; null when gone. */
  private reresolve(state: MateSlotState): MateSlotState | null {
    return reresolveSlot(this.hooks.getAssembly(), this.viewer.getAssemblyController(), state);
  }

  private sameConnector(a: MateSlotState | null, b: ConnectorSlotState): boolean {
    return sameConnectorSlot(a, b);
  }

  /**
   * The pen-button editor renamed a picked connector in its part file:
   * re-point the slot at the new name so the pending render's re-resolve
   * (which matches by name) doesn't drop the pick.
   */
  noteConnectorRenamed(slot: ConnectorSlotState, newName: string): void {
    for (const key of ['a', 'b'] as const) {
      const state = this.slots[key];
      if (!state || state !== slot || state.kind !== 'connector') continue;
      state.connectorName = newName;
      this.panel.setSlotChip(key, connectorChipLabel(state));
    }
    this.refreshPreview();
  }

  /** The statement anchor + `.parts` chain (and replica row) for a pick — see side-resolve. */
  private resolveSideChain(state: ConnectorSlotState): ResolvedSideChain | { error: string } {
    return resolveSideChain(this.hooks.getAssembly(), state);
  }

  /**
   * Both connector picks resolved for writing, or the reason they can't be.
   * The statement lands where its anchors live: the current file for
   * root-scope and sub-assembly picks alike (a nested pick anchors on its
   * occurrence's insert() here), so the chains must agree on one file — and
   * in edit mode that file must be the statement's own.
   */
  private resolveConnectorSides():
    | { a: ResolvedSideChain | null; b: ResolvedSideChain | null }
    | { error: string } {
    const chains: (ResolvedSideChain | null)[] = [];
    for (const state of [this.slots.a, this.slots.b]) {
      if (state?.kind !== 'connector') {
        chains.push(null); // empty and assembly-connector slots constrain nothing here
        continue;
      }
      const chain = this.resolveSideChain(state);
      if ('error' in chain) {
        return { error: chain.error };
      }
      if (this.editTarget && chain.filePath !== this.editTarget.filePath) {
        return { error: `${state.instanceName} is not reachable from this mate's file — pick a connector the statement's own file inserts.` };
      }
      chains.push(chain);
    }
    const [a, b] = chains;
    if (a && b && a.filePath !== b.filePath) {
      return { error: 'The two picks are inserted by different files — mate them in the file that inserts both.' };
    }
    // An assembly connector anchors on its own statement's file: the other
    // side (and an edit target) must live there too.
    for (const state of [this.slots.a, this.slots.b]) {
      if (state?.kind !== 'world') continue;
      const otherFile = a?.filePath ?? b?.filePath ?? this.editTarget?.filePath;
      if (otherFile && otherFile !== state.filePath) {
        return { error: `${state.connectorName} is declared in a different file than the other side — mate them in the file that declares it.` };
      }
    }
    return { a, b };
  }

  /**
   * The pick constraint behind the Apply button. Tangent sides still
   * reference their instance's own file directly — a pick inside a
   * sub-assembly is refused at pick time, so only the same-file rule
   * remains here; connector sides defer to {@link resolveConnectorSides}.
   */
  private crossFileConflict(): string | null {
    if (this.panel.getType() !== 'tangent') {
      const sides = this.resolveConnectorSides();
      return 'error' in sides ? sides.error : null;
    }
    const a = this.tangentSlots.a;
    const b = this.tangentSlots.b;
    if (this.editTarget) {
      for (const state of [a, b]) {
        if (state && state.filePath !== this.editTarget.filePath) {
          return `${state.instanceName} is inserted by a different file than this mate — pick geometry from an instance of the mate's own file.`;
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
    // every refresh because renders re-mint the scene ids. An assembly
    // connector pins under the world body id.
    this.viewer.getAssemblyController()?.setMatePickedConnectors(
      [this.slots.a, this.slots.b]
        .filter((s): s is MateSlotState => s !== null)
        .map(s => s.kind === 'world'
          ? { instanceId: WORLD_BODY_ID, connectorId: s.connectorId }
          : { instanceId: s.instanceId, connectorId: s.connectorId }),
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
    // Stand-in refs (display names for bindings, server writes truth); a
    // sub-assembly pick previews its `.parts` export chain, `…` marking a
    // key the server will export on Apply.
    const ref = (s: MateSlotState | null) => {
      if (s === null) {
        return '…';
      }
      if (s.kind === 'world') {
        return s.connectorName;
      }
      return previewConnectorRef(this.hooks.getAssembly(), s);
    };
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
      const solverSide = (s: MateSlotState) => s.kind === 'world'
        ? worldConnectorRef(s)
        : { instanceId: s.instanceId, connectorId: s.connectorId };
      const record: MateRecord = {
        // Edit sessions reuse the committed record's id: the controller
        // solves the provisional record INSTEAD of the mate it replaces.
        mateId: this.editTarget?.mateId ?? PREVIEW_MATE_ID,
        type: values.type,
        connectorA: solverSide(a),
        connectorB: solverSide(b),
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
    // The statement lands where its anchors live: the file whose insert()
    // each side dereferences through — a nested pick anchors on its
    // occurrence's insert() there — or the file declaring an assembly
    // connector side (resolveConnectorSides checked they agree).
    const sides = this.resolveConnectorSides();
    if ('error' in sides) {
      this.panel.setMessage(sides.error);
      return;
    }
    const worldFile = [a, b].find((s): s is WorldSlotState => s.kind === 'world')?.filePath;
    const anchorFile = sides.a?.filePath ?? sides.b?.filePath ?? worldFile;
    if (!anchorFile) {
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const connectorRef = (s: ConnectorSlotState, chain: ResolvedSideChain): AssemblyMateConnectorRef =>
        connectorRefFor(s, chain);
      const sideRef = (key: 'A' | 'B', s: MateSlotState, chain: ResolvedSideChain | null) => s.kind === 'world'
        ? { [`frame${key}`]: { connectorLine: s.connectorLine, connectorName: s.connectorName } }
        : { [`connector${key}`]: connectorRef(s, chain!) };
      const target = this.editTarget;
      const payload = {
        type: values.type,
        ...sideRef('A', a, sides.a),
        ...sideRef('B', b, sides.b),
        options,
      };
      const result = await applyAssemblyMate(
        target?.filePath ?? anchorFile,
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
        ...(s.replicaRow !== undefined ? { replicaRow: s.replicaRow } : {}),
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

export type { ConnectorSlotState, MateSlotState, WorldSlotState } from './side-resolve';

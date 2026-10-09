import { RelationPanel, RELATION_TYPE_LABELS, type RelationSlotKey } from './relation-panel';
import { ConnectorPickMenu } from '../assembly-mate/connector-pick-menu';
import { applyAssemblyRelation, type AssemblyRelationPayload, type AssemblyRelationType } from '../../api';
import type { Viewer } from '../../viewer';
import type { SelectionModifiers } from '../../viewer';
import type { SerializedAssembly, SerializedAssemblyMate, SerializedAssemblyRelation, SubSelection } from '../../types';
import type { RelationRecord } from '../../solver';
import { MateLabel } from '../../ui/mate-label';

/**
 * One picked mate: its stable source address (what Apply writes and what a
 * re-render re-resolves through), its id in the current render (what the
 * provisional solve couples) and what the chip says.
 */
export type RelationSlotState = {
  mateId: string;
  filePath: string;
  sourceLine: number;
  type: SerializedAssemblyMate['type'];
  label: string;
};

/** The provisional record's id — never collides with `rel-<n>` scene ids. */
const PREVIEW_RELATION_ID = '__relation-preview__';

/** Mate types each slot accepts (the kernel's RelationRules, restated for the chips). */
const ROTATING = new Set<SerializedAssemblyMate['type']>(['revolute', 'cylindrical']);
const SLIDING = new Set<SerializedAssemblyMate['type']>(['slider', 'cylindrical']);

/**
 * The relation statement an open dialog is editing: its stable source
 * address plus the committed record's id in the current render — the
 * provisional preview reuses that id so the solver swaps the committed
 * relation out instead of fighting it.
 */
type RelationEditTarget = {
  filePath: string;
  sourceLine: number;
  relationId: string;
};

/**
 * The relation tool: a toolbar Gear / Rack button opens the
 * {@link RelationPanel} with that type preselected and mate picking armed.
 * A mate is picked from the Joints panel's rows ({@link pickMate}) or by
 * clicking a part in the viewport ({@link handleClick}) — one eligible joint
 * on that part fills the slot, several open a "which joint?" popover. With
 * both slots filled the candidate relation is solved live as a provisional
 * record — dragging either part turns the other while the dialog is open.
 * Apply writes the `relation()` statement through `api/assembly-relation`.
 *
 * The joints panel's "Edit relation" opens the same dialog seeded from an
 * existing statement ({@link beginEdit}), the preview REPLACING the
 * committed relation in the solve, and Apply re-rendering it in place.
 */
export class AssemblyRelationService {
  private panel: RelationPanel;
  private pickMenu: ConnectorPickMenu;
  private armed = false;
  private applying = false;
  private editTarget: RelationEditTarget | null = null;
  private slots: Record<RelationSlotKey, RelationSlotState | null> = { a: null, b: null };

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private hooks: {
      getAssembly: () => SerializedAssembly | null;
      /** The dialog opened — dismiss the transform gizmo / viewport selection, arm the joints panel. */
      onEnter?: () => void;
      onExit?: () => void;
    },
  ) {
    this.panel = new RelationPanel(container);
    this.pickMenu = new ConnectorPickMenu(container);
    this.panel.onApply = () => void this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshPreview();
    };
    this.panel.onRemoveMate = (slot) => {
      this.slots[slot] = null;
      this.panel.setSlotChip(slot, null);
      this.panel.armSlot(slot);
      this.panel.setMessage(null);
      this.refreshPreview();
    };
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** The armed dialog owns viewport clicks and joints-panel rows. */
  get isPicking(): boolean {
    return this.armed;
  }

  /**
   * A toolbar relation button: open the dialog armed for picking with the
   * given type, or — already open in create mode — just switch the type
   * (a pick the new type can't take drops back to the prompt). An open edit
   * session ends first: the toolbar means "create a NEW relation".
   */
  enter(type: AssemblyRelationType): void {
    if (this.armed) {
      if (!this.editTarget) {
        this.panel.setType(type);
        for (const key of ['a', 'b'] as const) {
          const state = this.slots[key];
          if (state && this.eligibility(key, state.type) !== null) {
            this.slots[key] = null;
            this.panel.setSlotChip(key, null);
          }
        }
        this.panel.armSlot(this.slots.a ? 'b' : 'a');
        this.refreshPreview();
        return;
      }
      this.exit();
    }
    this.armed = true;
    this.slots = { a: null, b: null };
    this.panel.show(type);
    this.syncViewport();
    this.hooks.onEnter?.();
    this.refreshPreview();
  }

  /**
   * The joints panel's "Edit relation": open the dialog seeded from the
   * relation's serialized record — type, ratio and sense into the form,
   * both mates as picked chips, the statement's source address as the
   * Apply target. A mate that no longer resolves opens its slot empty with
   * the reason shown; picking refills it like create mode.
   */
  beginEdit(relation: SerializedAssemblyRelation): void {
    if (this.applying) {
      return;
    }
    const location = relation.sourceLocation;
    if (!location || relation.owner) {
      return; // owned relations edit in their own file — the menu already gates this
    }
    if (this.armed) {
      this.exit();
    }
    this.armed = true;
    this.editTarget = { filePath: location.filePath, sourceLine: location.line, relationId: relation.relationId };
    this.slots = { a: null, b: null };
    this.panel.show(relation.type, { ratio: relation.ratio, reverse: relation.reverse });
    let problem: string | null = null;
    for (const key of ['a', 'b'] as const) {
      const state = this.resolveMate(key === 'a' ? relation.mateA : relation.mateB);
      if ('error' in state) {
        problem = problem ?? state.error;
        continue;
      }
      this.slots[key] = state;
      this.panel.setSlotChip(key, state.label);
    }
    this.panel.armSlot(this.slots.a ? 'b' : 'a');
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
    this.pickMenu.close();
    this.syncViewport();
    this.panel.hide();
    this.hooks.onExit?.();
  }

  /**
   * A Joints-panel row clicked while armed (or a viewport pick resolved to
   * one mate): the mate fills the armed slot when the slot's type rule takes
   * it, and the armed border moves on to the other slot while it is empty.
   */
  pickMate(mateId: string): void {
    if (!this.armed) {
      return;
    }
    this.pickMenu.close();
    const state = this.resolveMate(mateId);
    if ('error' in state) {
      this.panel.setMessage(state.error);
      return;
    }
    const slot = this.panel.getArmedSlot();
    const other: RelationSlotKey = slot === 'a' ? 'b' : 'a';
    const problem = this.eligibility(slot, state.type);
    if (problem) {
      this.panel.setMessage(problem);
      return;
    }
    if (this.slots[other]?.mateId === state.mateId) {
      this.panel.setMessage('A mate cannot be related to itself — pick a different joint.');
      return;
    }
    this.slots[slot] = state;
    this.panel.setSlotChip(slot, state.label);
    this.panel.setMessage(null);
    if (!this.slots[other]) {
      this.panel.armSlot(other);
    }
    this.refreshPreview();
  }

  /**
   * Routes viewport clicks while armed: a click on a part offers the joints
   * on that part the armed slot can take — one fills the slot outright,
   * several open the popover, none shows why. Empty-space clicks keep the
   * picks (misclicks shouldn't wipe them).
   */
  handleClick(
    shapeId: string | null,
    sub: SubSelection,
    instanceId: string | null,
    pick?: Pick<SelectionModifiers, 'clientX' | 'clientY'>,
  ): void {
    if (!this.armed) {
      return;
    }
    this.pickMenu.close();
    if (!instanceId) {
      return;
    }
    const assembly = this.hooks.getAssembly();
    const instance = assembly?.instances.find(i => i.instanceId === instanceId);
    if (!assembly || !instance) {
      return;
    }
    const slot = this.panel.getArmedSlot();
    const onInstance = assembly.mates.filter(m =>
      m.connectorA?.instanceId === instanceId || m.connectorB?.instanceId === instanceId
      || m.geometryA?.instanceId === instanceId || m.geometryB?.instanceId === instanceId);
    const eligible = onInstance.filter(m => this.eligibility(slot, m.type) === null && !('error' in this.resolveMate(m.mateId)));
    if (eligible.length === 1) {
      this.pickMate(eligible[0].mateId);
      return;
    }
    if (eligible.length === 0) {
      const wanted = this.wantedTypes(slot);
      this.panel.setMessage(
        onInstance.length === 0
          ? `${instance.name} has no mates yet — mate it first, then relate the joint.`
          : `${instance.name} has no ${wanted} mate of its own file to couple — pick a joint from the Joints panel.`,
      );
      return;
    }
    if (pick?.clientX === undefined || pick.clientY === undefined) {
      this.pickMate(eligible[0].mateId);
      return;
    }
    const names = this.instanceNames(assembly);
    const world = MateLabel.worldConnectorNames(assembly.connectors ?? []);
    this.pickMenu.show(pick.clientX, pick.clientY, eligible.map(mate => ({
      label: MateLabel.describe(mate, names, world),
      onHover: () => this.viewer.highlightMate(mate),
      onPick: () => this.pickMate(mate.mateId),
    })), () => this.highlightPicked(), 'Which joint?');
  }

  /**
   * Every assembly render lands here: ids were re-minted, so each pick
   * re-resolves through its stable (file, line) address — a pick whose
   * statement is gone drops back to the prompt. A render that switched to
   * a part scene closes the dialog, and so does an edit session whose
   * `relation()` statement no longer starts on the edited line.
   */
  handleSceneRendered(sceneKind: 'part' | 'assembly'): void {
    if (!this.armed) {
      return;
    }
    if (sceneKind !== 'assembly') {
      this.exit();
      return;
    }
    const assembly = this.hooks.getAssembly();
    if (this.editTarget) {
      const fresh = assembly?.relations?.find(r =>
        r.sourceLocation?.filePath === this.editTarget!.filePath
        && r.sourceLocation.line === this.editTarget!.sourceLine
        && !r.owner);
      if (!fresh) {
        this.exit();
        return;
      }
      this.editTarget.relationId = fresh.relationId;
    }
    this.syncViewport();
    for (const key of ['a', 'b'] as const) {
      const state = this.slots[key];
      if (!state) {
        continue;
      }
      const match = assembly?.mates.find(m =>
        m.sourceLocation?.filePath === state.filePath
        && m.sourceLocation.line === state.sourceLine
        && !m.owner && !m.replica);
      const fresh = match ? this.resolveMate(match.mateId) : null;
      if (fresh && !('error' in fresh)) {
        this.slots[key] = fresh;
        this.panel.setSlotChip(key, fresh.label);
      } else {
        this.slots[key] = null;
        this.panel.setSlotChip(key, null);
      }
    }
    this.refreshPreview();
  }

  /**
   * Arm/disarm the controller for the current state: while armed a click on
   * a part means "pick", not "drag", and the joints the user hunts for show
   * their connectors on hover. Connector gizmos are not pick targets here.
   */
  private syncViewport(): void {
    const controller = this.viewer.getAssemblyController();
    controller?.setMatePicking(this.armed, false);
    if (!this.armed) {
      controller?.setProvisionalRelation(null);
      this.viewer.clearInstanceHighlight();
    }
  }

  /** Why the mate type can't fill the slot under the current relation type, or null. */
  private eligibility(slot: RelationSlotKey, mateType: SerializedAssemblyMate['type']): string | null {
    const type = this.panel.getType();
    const allowed = slot === 'a' || type === 'gear' ? ROTATING : SLIDING;
    if (allowed.has(mateType)) {
      return null;
    }
    const label = MateLabel.TYPE_LABELS[mateType].toLowerCase();
    if (type === 'gear') {
      return `A gear couples two rotating mates — a ${label} mate has no rotation to couple. Pick a revolute or cylindrical joint.`;
    }
    return slot === 'a'
      ? `The pinion side takes a rotating mate — a ${label} mate has no rotation to couple. Pick a revolute or cylindrical joint.`
      : `The rack side takes a sliding mate — a ${label} mate has no travel to couple. Pick a slider or cylindrical joint${mateType === 'planar' ? ' (a planar mate frees two directions and a spin, so there is no single travel)' : ''}.`;
  }

  private wantedTypes(slot: RelationSlotKey): string {
    return slot === 'a' || this.panel.getType() === 'gear' ? 'revolute or cylindrical' : 'slider or cylindrical';
  }

  /** A mate id in the current render → the slot state, or why it can't be used. */
  private resolveMate(mateId: string): RelationSlotState | { error: string } {
    const assembly = this.hooks.getAssembly();
    const mate = assembly?.mates.find(m => m.mateId === mateId);
    if (!assembly || !mate) {
      return { error: 'Could not resolve the joint — try re-rendering.' };
    }
    if (mate.owner) {
      return { error: 'That joint lives inside a sub-assembly — relate it in the sub-assembly\'s own file.' };
    }
    if (mate.replica) {
      return { error: 'That joint is a replica (its statement is the replicate() call) — relate the seed\'s joint instead.' };
    }
    if (!mate.sourceLocation) {
      return { error: 'That joint has no source location — its mate() statement cannot be referenced.' };
    }
    const names = this.instanceNames(assembly);
    const world = MateLabel.worldConnectorNames(assembly.connectors ?? []);
    return {
      mateId: mate.mateId,
      filePath: mate.sourceLocation.filePath,
      sourceLine: mate.sourceLocation.line,
      type: mate.type,
      label: MateLabel.describe(mate, names, world),
    };
  }

  private instanceNames(assembly: SerializedAssembly): Map<string, string> {
    return new Map(assembly.instances.map(i => [i.instanceId, i.name]));
  }

  /** Both picked mates tinted in the viewport (the connectors pinned), or nothing. */
  private highlightPicked(): void {
    const assembly = this.hooks.getAssembly();
    const mates = [this.slots.a, this.slots.b]
      .map(s => (s ? assembly?.mates.find(m => m.mateId === s.mateId) : undefined))
      .filter((m): m is SerializedAssemblyMate => m !== undefined);
    if (mates.length > 0) {
      this.viewer.highlightMates(mates);
    } else {
      this.viewer.clearInstanceHighlight();
    }
  }

  /** The pick constraint behind the Apply button: both mates in the file the statement lands in. */
  private fileConflict(): string | null {
    const a = this.slots.a;
    const b = this.slots.b;
    const target = this.editTarget?.filePath;
    for (const state of [a, b]) {
      if (state && target && state.filePath !== target) {
        return 'That joint is declared in a different file than this relation — pick joints from the relation\'s own file.';
      }
    }
    if (a && b && a.filePath !== b.filePath) {
      return 'The two joints are declared in different files — relate them in the file that declares both.';
    }
    return null;
  }

  /** Sync the statement preview row, the Apply button, the highlight and the live solver preview. */
  private refreshPreview(): void {
    if (!this.armed) {
      return;
    }
    this.highlightPicked();
    const values = this.panel.values();
    const assembly = this.hooks.getAssembly();
    const standIn = (s: RelationSlotState | null) => {
      const mate = s ? assembly?.mates.find(m => m.mateId === s.mateId) : undefined;
      return mate ? MateLabel.standIn(mate) : '…';
    };
    if ('error' in values) {
      this.panel.setMessage(values.error);
      this.panel.setApplyEnabled(false);
      this.viewer.getAssemblyController()?.setProvisionalRelation(null);
      return;
    }
    const a = this.slots.a;
    const b = this.slots.b;
    let chain = `relation('${values.type}', ${standIn(a)}, ${standIn(b)}, ${values.ratio})`;
    if (values.reverse) {
      chain += '.reverse()';
    }
    this.panel.setPreview(`${chain};`);
    const conflict = this.fileConflict();
    if (conflict) {
      this.panel.setMessage(conflict);
    }
    this.panel.setApplyEnabled(a !== null && b !== null && conflict === null && !this.applying);

    const controller = this.viewer.getAssemblyController();
    if (a && b && conflict === null && controller) {
      const record: RelationRecord = {
        // Edit sessions reuse the committed record's id: the controller
        // solves the provisional record INSTEAD of the relation it replaces.
        relationId: this.editTarget?.relationId ?? PREVIEW_RELATION_ID,
        type: values.type,
        mateA: a.mateId,
        mateB: b.mateId,
        ratio: values.ratio,
        reverse: values.reverse,
      };
      controller.setProvisionalRelation(record);
    } else {
      controller?.setProvisionalRelation(null);
    }
  }

  private async apply(): Promise<void> {
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
    // Enter in the ratio field submits past a disabled Apply button —
    // re-check the pick constraint the button encodes.
    const conflict = this.fileConflict();
    if (conflict) {
      this.panel.setMessage(conflict);
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const target = this.editTarget;
      const payload: AssemblyRelationPayload = {
        type: values.type,
        mateA: { mateLine: a.sourceLine },
        mateB: { mateLine: b.sourceLine },
        ratio: values.ratio,
        ...(values.reverse ? { reverse: true } : {}),
      };
      const result = await applyAssemblyRelation(
        target?.filePath ?? a.filePath,
        target ? { edit: { sourceLine: target.sourceLine, ...payload } } : { create: payload },
      );
      if (!result.success) {
        this.panel.setMessage(
          result.reason ?? (target ? 'Could not update the relation.' : 'Could not add the relation.'),
        );
        this.panel.setApplyEnabled(true);
        return;
      }
      // The committed statement re-renders with the real relation; drop
      // the provisional record so it can't double-couple, keeping the poses.
      this.viewer.getAssemblyController()?.commitProvisionalRelation();
      this.exit();
    } finally {
      this.applying = false;
    }
  }
}

export { RELATION_TYPE_LABELS };

import { MatePanel, MateSlotKey } from './mate-panel';
import {
  applyAssemblyMate,
  applyConnector,
  AssemblyMateOptions,
  AssemblyMateType,
  fetchConnectorAnchors,
  type ApplyFeatureEntity,
} from '../../api';
import type { Viewer } from '../../viewer';
import type { SerializedAssembly, SubSelection } from '../../types';
import type { MateRecord } from '../../solver';

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
  /**
   * 'part' — a part-owned connector, referenced as
   * `<binding>.connectors.<name>`; 'instance' — an assembly-scoped connector
   * bound to this one instance, referenced by its own `const` binding.
   */
  scope: 'part' | 'instance';
};

/** The provisional record's id — never collides with `mate-<n>` scene ids. */
const PREVIEW_MATE_ID = '__mate-preview__';

/**
 * The assembly mate tool: a toolbar mate button opens the {@link MatePanel}
 * with that type preselected, connector picking armed (all gizmos revealed,
 * instance drags suppressed), and picks filling Connector A then B. With
 * both slots filled the candidate mate is solved live as a provisional
 * record — the parts pull together while the dialog is open, and snap back
 * if it closes without applying. Apply writes the `mate()` statement through
 * `/api/assembly-mate`; the render it triggers shows the committed joint.
 */
export class AssemblyMateService {
  private panel: MatePanel;
  private armed = false;
  private applying = false;
  /** An on-the-fly connector create is in flight — further face/edge clicks wait. */
  private creatingConnector = false;
  private slots: Record<MateSlotKey, MateSlotState | null> = { a: null, b: null };

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
      this.panel.setSlotChip(slot, null);
      this.panel.armSlot(slot, { silent: true });
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
   * type, or — already open — just switch the type dropdown.
   */
  enter(type: AssemblyMateType): void {
    if (this.armed) {
      this.panel.setType(type);
      this.refreshPreview();
      return;
    }
    this.armed = true;
    this.slots = { a: null, b: null };
    this.panel.show(type);
    this.syncViewport();
    this.hooks.onEnter?.();
    this.refreshPreview();
  }

  exit(): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.slots = { a: null, b: null };
    this.syncViewport();
    this.panel.hide();
    this.hooks.onExit?.();
  }

  /**
   * Routes viewport clicks while armed. A connector pick fills the armed
   * slot (and hands the armed border to the other slot when it's still
   * empty); a face/edge pick creates a connector on the fly in the part's
   * own file and fills the slot with it once the render brings it in.
   */
  handleClick(shapeId: string | null, sub: SubSelection, instanceId: string | null): void {
    if (!this.armed) {
      return;
    }
    if (!shapeId || !sub) {
      return; // empty-space click keeps the picks (misclicks shouldn't wipe them)
    }
    if (sub.type !== 'connector') {
      if (sub.type === 'face' || sub.type === 'edge') {
        void this.createConnectorFromPick(
          { shapeId, sub: { type: sub.type, index: sub.index } },
          instanceId,
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
      this.panel.armSlot(other, { silent: true });
    }
    this.refreshPreview();
  }

  /**
   * Every assembly render lands here: scene ids were re-minted, so each pick
   * re-resolves through its stable (instance line, connector name) address —
   * a pick whose statement is gone drops back to the prompt. A render that
   * switched to a part scene closes the dialog.
   */
  handleSceneRendered(sceneKind: 'part' | 'assembly'): void {
    if (!this.armed) {
      return;
    }
    if (sceneKind !== 'assembly') {
      this.exit();
      return;
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
    this.refreshPreview();
  }

  /** Arm/disarm the viewer channel + controller reveal for the current state. */
  private syncViewport(): void {
    this.viewer.pickConnectors = this.armed;
    const controller = this.viewer.getAssemblyController();
    controller?.setMatePicking(this.armed);
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
      return { error: 'Could not resolve the clicked connector to an instance — try re-rendering.' };
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
      scope: controller?.getConnectorInstanceId(connectorId) ? 'instance' : 'part',
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
      // A just-created connector (pending, no scene id yet) stays put until
      // the render that carries it arrives; only a pick that HAD an id and
      // lost it is really gone.
      return state.connectorId === '' ? state : null;
    }
    return {
      ...state,
      instanceId: instance.instanceId,
      connectorId,
      instanceName: instance.name,
    };
  }

  /**
   * A face/edge click while a slot is armed: create a connector on the fly
   * (default anchor, `c<N>` default name — the pen button edits it
   * afterwards) and fill the slot with a pending pick that the next render
   * resolves to the new connector's scene id. The panel's scope choice
   * decides where it lives: 'instance' (default) binds it to the clicked
   * instance in the assembly file; 'part' writes into the part's own file,
   * so it appears on every instance.
   */
  private async createConnectorFromPick(
    entity: ApplyFeatureEntity,
    instanceId: string | null,
  ): Promise<void> {
    if (this.creatingConnector) {
      return;
    }
    const assembly = this.hooks.getAssembly();
    const instance = instanceId
      ? assembly?.instances.find(i => i.instanceId === instanceId)
      : undefined;
    if (!instance?.sourceLocation) {
      this.panel.setMessage('Could not resolve the clicked geometry to an instance.');
      return;
    }
    const scope = this.panel.getConnectorScope();
    this.creatingConnector = true;
    try {
      const suggestion = await fetchConnectorAnchors(
        entity, undefined, scope === 'instance' ? instance.instanceId : undefined,
      );
      if (!this.armed) {
        return;
      }
      if (suggestion.ok === false) {
        this.panel.setMessage(suggestion.reason ?? 'No connector anchor available on this shape.');
        return;
      }
      const result = await applyConnector({
        name: suggestion.defaultName,
        entities: [entity],
        anchor: suggestion.anchors[0]?.anchor,
        ...(scope === 'instance' ? { instanceId: instance.instanceId } : {}),
      });
      if (!this.armed) {
        return;
      }
      if (!result.success) {
        this.panel.setMessage(result.reason ?? 'Could not create the connector.');
        return;
      }
      const slot = this.panel.getArmedSlot();
      const other: MateSlotKey = slot === 'a' ? 'b' : 'a';
      this.slots[slot] = {
        instanceId: instance.instanceId,
        connectorId: '', // pending — the render that brings the statement in resolves it
        instanceLine: instance.sourceLocation.line,
        connectorName: suggestion.defaultName,
        instanceName: instance.name,
        filePath: instance.sourceLocation.filePath,
        scope,
      };
      this.panel.setSlotChip(slot, `${instance.name} · ${suggestion.defaultName}`);
      this.panel.setMessage(null);
      if (!this.slots[other]) {
        this.panel.armSlot(other, { silent: true });
      }
      this.refreshPreview();
    } finally {
      this.creatingConnector = false;
    }
  }

  private sameConnector(a: MateSlotState | null, b: MateSlotState): boolean {
    return a !== null
      && a.instanceLine === b.instanceLine
      && a.connectorName === b.connectorName
      && a.scope === b.scope;
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
   * Sync the statement preview row, the Apply button, and the live solver
   * preview to the current picks + options.
   */
  private refreshPreview(): void {
    if (!this.armed) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      this.panel.setApplyEnabled(false);
      this.viewer.getAssemblyController()?.setProvisionalMate(null);
      return;
    }
    const a = this.slots.a;
    const b = this.slots.b;
    // Instance-scoped connectors are referenced by their own const binding —
    // the connector name stands in for it (the server writes the truth).
    const ref = (s: MateSlotState | null) =>
      s
        ? (s.scope === 'instance' ? s.connectorName : `${s.instanceName}.connectors.${s.connectorName}`)
        : '…';
    let chain = `mate('${values.type}', ${ref(a)}, ${ref(b)})`;
    if (values.flip) chain += '.flip()';
    if (values.rotate !== 0) chain += `.rotate(${values.rotate})`;
    if (values.offset.some(n => n !== 0)) chain += `.offset(${values.offset.join(', ')})`;
    if (values.limits) chain += `.limits(${values.limits.join(', ')})`;
    this.panel.setPreview(`${chain};`);
    this.panel.setApplyEnabled(a !== null && b !== null && !this.applying);

    const controller = this.viewer.getAssemblyController();
    // Pending picks (a just-created connector awaiting its render) have no
    // scene id yet — the provisional solve waits for both to resolve.
    if (a && b && a.connectorId && b.connectorId && controller) {
      const record: MateRecord = {
        mateId: PREVIEW_MATE_ID,
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
        ...(s.scope === 'instance' ? { scope: 'instance' as const } : {}),
      });
      const result = await applyAssemblyMate(a.filePath, {
        create: {
          type: values.type,
          connectorA: sideRef(a),
          connectorB: sideRef(b),
          options,
        },
      });
      if (!result.success) {
        this.panel.setMessage(result.reason ?? 'Could not add the mate.');
        this.panel.setApplyEnabled(true);
        return;
      }
      // The committed statement re-renders with the real mate; the provisional
      // preview must not double-solve it in the meantime.
      this.viewer.getAssemblyController()?.setProvisionalMate(null);
      this.exit();
    } finally {
      this.applying = false;
    }
  }
}

export type { MateSlotState };

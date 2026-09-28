import {
  applyAssemblyConnectorCopy, parseFeatureAt,
  type ApplyFeatureResponse, type AssemblyConnectorCopyPayload, type AssemblyCopyAxisRef, type AssemblyCopyTargetRef,
  type CopyGhostRequest,
  type GhostAxisRef, type GhostGeometry, type NewVariable, type ParsedFeatureStatement,
  fetchFeatureGhostResult, getScopeVariables,
} from '../../api';
import { WORLD_BODY_ID } from '../../solver';
import type { StandardAxisId } from '../../scene/standard-axes';
import type { SerializedAssembly, SubSelection } from '../../types';
import type { SelectionModifiers, Viewer } from '../../viewer';
import { ConnectorPickMenu } from '../assembly-mate/connector-pick-menu';
import { ApplyRunner } from '../create-feature/apply-runner';
import { ConnectorOption, ConnectorOptions } from '../create-feature/connector-options';
import { CopyDirection, CopyPanel } from '../create-feature/copy-panel';
import { FeatureGhostOverlay } from '../create-feature/feature-ghost';

type ParsedCopy = Extract<ParsedFeatureStatement, { feature: 'copy' }>;

/**
 * One chosen target: an assembly connector by its option, or — editing — a
 * statement target the dialog could not name as one, kept verbatim by its
 * position.
 */
type TargetChoice =
  | { kind: 'connector'; option: ConnectorOption }
  | { kind: 'keep'; sourceIndex: number; label: string };

/** The copy statement an edit session rewrites: where it starts, and how it read when the dialog opened. */
type EditTarget = { filePath: string; line: number; column: number; parsed: ParsedCopy };

/** What the dialog sends: the statement write, and the declarations its fields committed. */
type CopyRequest = {
  spec:
    | { create: AssemblyConnectorCopyPayload }
    | { edit: AssemblyConnectorCopyPayload & { sourceLine: number } };
  newVariables?: NewVariable[];
};

/**
 * The Copy dialog at an assembly's top level: `copy('linear' | 'circular',
 * …)` of the assembly's own connectors (`connector('bay', [x, y, z])`) — the
 * part Copy dialog's panel, with assembly connectors for targets and a world
 * axis or an assembly connector's Z axis for the axis. A connector row's
 * "Copy…" opens it on that connector, a copy row opens it on the statement
 * that made the copy.
 *
 * Picks work like the mate dialog's: every assembly connector gizmo shows
 * and is screen-pickable for as long as the dialog is up (the controller's
 * mate-picking channel, instance connectors on hover only — they are
 * refused, since a part's connectors are copied in its own file), a row of
 * the rail's Connectors list picks too, and while an axis slot is armed the
 * world axes are shown as pick targets. The ghost draws the copies' triads
 * where the pattern puts them (`api/feature-ghost`); Apply writes through
 * `api/assembly-connector-copy`, whose preview answers the exact statement.
 */
export class AssemblyConnectorCopyService {
  private panel: CopyPanel;
  private pickMenu: ConnectorPickMenu;
  private ghost: FeatureGhostOverlay;
  private runner: ApplyRunner<CopyRequest, GhostGeometry>;
  private armed = false;
  /** Every assembly connector the payload lists — targets and axes are picked among them. */
  private options: ConnectorOption[] = [];
  /** The chosen targets, in pick order — the copy's argument order. */
  private targets: TargetChoice[] = [];
  /** The statement an edit session rewrites; null creating. */
  private editTarget: EditTarget | null = null;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private hooks: {
      getAssembly: () => SerializedAssembly | null;
      getCurrentFile: () => string | null;
      /** The dialog opened — the page dismisses the other assembly dialogs and flips the rail into picking. */
      onEnter?: () => void;
      onExit?: () => void;
    },
  ) {
    this.panel = new CopyPanel(container, {
      id: 'fluidcad-assembly-copy-panel',
      targetsLabel: 'Connectors',
      targetsPrompt: 'Pick assembly connectors — a gizmo, or a row of the Connectors list',
      axisPrompt: 'Pick a world axis or an assembly connector',
      // Following a repeat is part-only: an assembly has no repeat() to follow.
      followsRepeats: false,
    });
    this.pickMenu = new ConnectorPickMenu(container);
    this.ghost = new FeatureGhostOverlay(viewer);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
    };
    this.panel.onTypeChange = () => {
      this.syncViewport();
      this.refreshHighlight();
    };
    this.panel.onRemoveTarget = (index) => {
      this.targets.splice(index, 1);
      this.panel.setMessage(null);
      this.refresh();
      this.runner.schedulePreview();
    };
    this.panel.onAxisModeChange = () => this.refreshHighlight();
    this.panel.onArmedSlotChange = () => this.syncViewport();

    this.runner = new ApplyRunner<CopyRequest, GhostGeometry>({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.buildRequest(),
      send: (request, extras) => this.send(request, extras),
      onApplied: () => this.exit(),
      failMessage: () => (this.editTarget ? 'Could not apply the edit.' : 'Could not apply the copy.'),
      // The copies' triads where the pattern puts them, drawn translucent —
      // the statement preview's geometric twin, under the same debounce.
      ghost: {
        fetch: (_request, signal) => this.fetchGhost(signal),
        apply: (drawn) => {
          if (drawn) {
            this.ghost.set(drawn.solids, 'add', drawn.frames);
          } else {
            this.ghost.clear();
          }
        },
      },
    });
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** The open dialog owns viewport clicks in assembly mode, like the mate dialog. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** The Copy dialog on one connector — a Connectors row's "Copy…". */
  enterWithConnector(connectorId: string): void {
    if (this.armed) {
      this.exit();
    }
    this.open(null);
    this.panel.show();
    this.pickConnector(connectorId);
    this.afterOpen();
  }

  /**
   * The Copy dialog over the `copy()` statement at `location` — a copy
   * row's click or "Edit copy…". Targets the dialog can name open as their
   * connectors' chips, the rest as kept chips; axes open on the statement's
   * own ("Current: …", a world axis as itself). Answers the reason when the
   * statement can't be edited here.
   */
  async enterEdit(location: { filePath: string; line: number; column: number }): Promise<string | null> {
    const parsed = await parseFeatureAt(location);
    if (parsed.ok === false) {
      return parsed.reason;
    }
    const statement = parsed.parsed;
    if (statement.feature !== 'copy' || statement.center !== null) {
      return `The statement on line ${location.line} is not a copy the dialog can edit.`;
    }
    if (statement.kind === 'pattern') {
      return `The copy on line ${location.line} follows a repeat — that form is part-only; edit it in the source.`;
    }
    if (this.armed) {
      this.exit();
    }
    this.open({ ...location, parsed: statement });
    this.targets = statement.targetTexts.map((label, sourceIndex): TargetChoice => {
      const ref = statement.targetRefs[sourceIndex];
      const option = ref
        ? ConnectorOptions.forLocation({ filePath: location.filePath, line: ref.line }, this.options)
        : undefined;
      return option ? { kind: 'connector', option } : { kind: 'keep', sourceIndex, label };
    });
    this.panel.showEdit({
      kind: statement.kind,
      directions: statement.directions,
      spacingMode: statement.spacingMode,
      centered: statement.centered,
      count: statement.count,
      sweep: statement.sweep,
      skip: statement.skip,
      axisLabels: statement.axisTexts,
    });
    this.afterOpen();
    return null;
  }

  exit(): void {
    if (!this.armed) {
      return;
    }
    this.armed = false;
    this.editTarget = null;
    this.targets = [];
    this.pickMenu.close();
    this.runner.cancelPreview();
    this.ghost.clear();
    this.syncViewport();
    this.panel.hide();
    this.hooks.onExit?.();
  }

  /**
   * Every render lands here: a part scene closes the dialog; an assembly
   * render re-finds the picks by their sites (scene ids re-mint every
   * render) and previews again.
   */
  handleSceneRendered(sceneKind: 'part' | 'assembly'): void {
    if (!this.armed) {
      return;
    }
    if (sceneKind !== 'assembly') {
      this.exit();
      return;
    }
    // The geometry under the ghost just changed — drop it now and let the
    // debounce redraw it.
    this.ghost.clear();
    this.options = ConnectorOptions.fromAssembly(this.hooks.getAssembly()?.connectors ?? []);
    this.targets = this.targets.flatMap((target): TargetChoice[] => {
      if (target.kind === 'keep') {
        return [target];
      }
      const match = ConnectorOptions.forSite(target.option, this.options);
      return match ? [{ kind: 'connector', option: match }] : [];
    });
    this.panel.setConnectorOptions(this.options);
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * A viewport click while the dialog is up. A connector gizmo lands in the
   * armed slot — several under the cursor open the "which connector?" menu
   * first — an inserted part's connector is refused with the reason, and a
   * face or edge says what to pick instead.
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
      return; // empty space keeps the picks
    }
    if (sub.type !== 'connector') {
      this.panel.setMessage(this.isAxisPicking
        ? 'Pick a world axis or an assembly connector — its Z axis is the copy axis.'
        : 'An assembly copies its own connectors — pick one\'s gizmo, or its row in the Connectors list.');
      return;
    }
    const candidates = pick?.connectorCandidates;
    if (candidates && candidates.length > 1 && pick?.clientX !== undefined && pick.clientY !== undefined) {
      this.openPickMenu(candidates, pick.clientX, pick.clientY);
      return;
    }
    this.pickGizmo(shapeId, instanceId);
  }

  /** A Connectors row clicked while the dialog is up: that connector into the armed slot. */
  pickWorldConnector(connectorId: string): void {
    if (!this.armed) {
      return;
    }
    this.pickMenu.close();
    this.pickConnector(connectorId);
  }

  private get isAxisPicking(): boolean {
    return this.panel.armedSlot === 'axis1' || this.panel.armedSlot === 'axis2';
  }

  private open(editTarget: EditTarget | null): void {
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = editTarget;
    this.targets = [];
    this.options = ConnectorOptions.fromAssembly(this.hooks.getAssembly()?.connectors ?? []);
    void this.refreshScopeVariables();
  }

  private afterOpen(): void {
    this.panel.setConnectorOptions(this.options);
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    const variables = await getScopeVariables(line);
    if (this.armed && (this.editTarget?.line ?? null) === line) {
      this.panel.setScopeVariables(variables);
    }
  }

  /** A gizmo pick: an assembly connector lands in the armed slot; an inserted part's is refused. */
  private pickGizmo(connectorId: string, instanceId: string | null): void {
    if (instanceId !== WORLD_BODY_ID) {
      this.panel.setMessage(this.isAxisPicking
        ? 'An inserted part\'s connector can\'t be the copy axis — its pose is the assembly solver\'s. Pick a world axis or an assembly connector.'
        : 'An inserted part\'s connectors are copied in its own part file — here, pick the assembly\'s own connectors.');
      return;
    }
    this.pickConnector(connectorId);
  }

  /** The popover listing every connector under an ambiguous click, named the way code names them. */
  private openPickMenu(candidates: { instanceId: string | null; connectorId: string }[], clientX: number, clientY: number): void {
    const controller = this.viewer.getAssemblyController();
    const items = candidates.map(candidate => ({
      label: candidate.instanceId === WORLD_BODY_ID
        ? `Assembly · ${ConnectorOptions.forId(candidate.connectorId, this.options)?.label ?? candidate.connectorId}`
        : this.instanceCandidateLabel(candidate.instanceId, candidate.connectorId),
      onHover: () => controller?.setHighlightedConnector(candidate.connectorId),
      onPick: () => this.pickGizmo(candidate.connectorId, candidate.instanceId),
    }));
    this.pickMenu.show(clientX, clientY, items, () => controller?.setHighlightedConnector(null));
  }

  /** `Crank Shaft · shaft` — an inserted part's connector, as the pick menu lists it. */
  private instanceCandidateLabel(instanceId: string | null, connectorId: string): string {
    const instance = this.hooks.getAssembly()?.instances.find(i => i.instanceId === instanceId);
    const address = this.viewer.getAssemblyController()?.getConnectorRef(connectorId);
    const name = address ? (address.slot === undefined ? address.name : `${address.name}.instance(${address.slot})`) : '?';
    return `${instance?.name ?? instanceId ?? '?'} · ${name}`;
  }

  /** One assembly connector, by its id, into the armed slot. */
  private pickConnector(connectorId: string): void {
    const option = ConnectorOptions.forId(connectorId, this.options);
    if (!option) {
      this.panel.setMessage('That connector cannot be referenced — its connector() statement has no source location.');
      return;
    }
    if (this.isAxisPicking) {
      this.panel.selectConnectorAxis(option);
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
      return;
    }
    this.toggleTarget(option);
  }

  /**
   * Toggle a connector target chip. The kernel's family rules are refused
   * at the pick: a copy is never copied again — its seed is — and a
   * connector another copy() already copies is edited there, one copy
   * statement per connector (the statement being edited excepted).
   */
  private toggleTarget(option: ConnectorOption): void {
    const existing = this.targets.findIndex(t => t.kind === 'connector' && ConnectorOptions.sameSite(t.option, option));
    if (existing >= 0) {
      this.targets.splice(existing, 1);
    } else if (option.slot !== undefined) {
      this.panel.setMessage(
        `${option.label} is itself a copy — copy ${option.name} instead (a grid is one two-axis linear copy).`,
      );
      return;
    } else if (option.copiedAt !== undefined && option.copiedAt !== this.editTarget?.line) {
      this.panel.setMessage(
        `${option.label} is already copied by the copy on line ${option.copiedAt} — one copy statement per `
          + 'connector: edit that one instead.',
      );
      return;
    } else {
      this.targets.push({ kind: 'connector', option });
    }
    // The pick landed in the targets slot — it takes the armed border.
    this.panel.armSlot('targets');
    this.panel.setMessage(null);
    this.refresh();
    this.runner.schedulePreview();
  }

  /** The request Apply (and the preview) sends, or the message blocking it. */
  private buildRequest(): CopyRequest | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    if (values.kind === 'pattern') {
      return { error: 'Following a repeat is part-only — copy along or around an axis.' };
    }
    if (this.targets.length === 0) {
      return { error: 'Pick the assembly connectors to copy — a gizmo, or a row of the Connectors list.' };
    }
    const targets = this.targets.map((target): AssemblyCopyTargetRef => (target.kind === 'connector'
      ? { kind: 'connector', connectorLine: target.option.line, connectorName: target.option.name }
      : { kind: 'verbatim', sourceIndex: target.sourceIndex }));
    let payload: AssemblyConnectorCopyPayload;
    if (values.kind === 'linear') {
      const active = this.panel.directions;
      const directions: NonNullable<AssemblyConnectorCopyPayload['directions']> = [];
      for (let i = 0; i < active.length; i++) {
        const axis = this.axisRef(active[i], active.length > 1);
        if ('error' in axis) {
          return axis;
        }
        directions.push({ axis, ...values.directions[i] });
      }
      payload = {
        kind: 'linear', targets, directions, spacingMode: values.spacingMode,
        ...(values.centered ? { centered: true } : {}),
        ...(values.skip.length > 0 ? { skip: values.skip } : {}),
      };
    } else {
      const axis = this.axisRef(1, false);
      if ('error' in axis) {
        return axis;
      }
      payload = {
        kind: 'circular', targets, axis, count: values.count, sweep: values.sweep,
        ...(values.skip.length > 0 ? { skip: values.skip } : {}),
      };
    }
    const edit = this.editTarget;
    return {
      spec: edit ? { edit: { ...payload, sourceLine: edit.line } } : { create: payload },
      newVariables: values.newVariables,
    };
  }

  /** One direction's axis field, or the message blocking it. */
  private axisRef(direction: CopyDirection, named: boolean): AssemblyCopyAxisRef | { error: string } {
    const selection = this.panel.axisSelection(direction);
    if (selection?.kind === 'standard') {
      return { kind: 'standard', axis: selection.axis };
    }
    if (selection?.kind === 'connector') {
      const { line, name, slot } = selection.option;
      return { kind: 'connector', connectorLine: line, connectorName: name, ...(slot !== undefined ? { slot } : {}) };
    }
    if (selection?.kind === 'keep' && this.editTarget) {
      return { kind: 'keep', sourceIndex: selection.sourceIndex };
    }
    return { error: `Choose the axis to copy along${named ? ` for direction ${direction}` : ''} — a world axis or an assembly connector.` };
  }

  private async send(
    request: CopyRequest,
    extras: { preview?: true; signal?: AbortSignal },
  ): Promise<ApplyFeatureResponse> {
    const filePath = this.editTarget?.filePath ?? this.hooks.getCurrentFile();
    if (!filePath) {
      return { success: false, reason: 'No assembly file is open.' };
    }
    return applyAssemblyConnectorCopy(filePath, request.spec, {
      newVariables: request.newVariables,
      preview: extras.preview,
      signal: extras.signal,
    });
  }

  // -------------------------------------------------------------------------
  // Live geometry ("ghost")
  // -------------------------------------------------------------------------

  /**
   * The copies' frames for the current form state, from the rendered scene:
   * each target connector by its statement, each axis a world axis or a
   * connector's. A slot the ghost can't address (a kept expression target,
   * an unpicked axis) means no ghost.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostGeometry | null> {
    const values = this.panel.values();
    if ('error' in values || values.kind === 'pattern') {
      return null;
    }
    const targets = this.ghostTargets();
    if (!targets) {
      return null;
    }
    const request: CopyGhostRequest = {
      feature: 'copy',
      kind: values.kind,
      targets,
      axes: [],
      directions: [],
      centered: false,
      count: null,
      sweep: null,
      skip: values.skip,
    };
    if (values.kind === 'linear') {
      const active = this.panel.directions;
      for (let i = 0; i < active.length; i++) {
        const axis = this.ghostAxis(active[i]);
        if (!axis) {
          return null;
        }
        const { count, value } = values.directions[i];
        request.axes.push(axis);
        request.directions.push({
          count,
          offset: values.spacingMode === 'offset' ? value : null,
          length: values.spacingMode === 'length' ? value : null,
        });
      }
      request.centered = values.centered;
    } else {
      const axis = this.ghostAxis(1);
      if (!axis) {
        return null;
      }
      request.axes.push(axis);
      request.count = values.count;
      request.sweep = values.sweep;
    }
    const edit = this.editTarget;
    const scope = edit ? { kind: 'statement' as const, filePath: edit.filePath, line: edit.line, column: edit.column } : null;
    const result = await fetchFeatureGhostResult(request, scope, signal);
    if (result.notice && !signal.aborted && this.armed) {
      this.panel.setMessage(result.notice);
    }
    return result.solids ? { solids: result.solids, frames: result.frames } : null;
  }

  /** The connectors being copied, by their statements; null while a kept target names none. */
  private ghostTargets(): { filePath: string; line: number }[] | null {
    const refs: { filePath: string; line: number }[] = [];
    for (const target of this.targets) {
      if (target.kind === 'keep') {
        return null;
      }
      refs.push({ filePath: target.option.filePath, line: target.option.line });
    }
    return refs.length > 0 ? refs : null;
  }

  /**
   * One direction's axis as the kernel resolves it — a kept statement axis
   * by the connector it names (`axisRefs`), when it names one.
   */
  private ghostAxis(direction: CopyDirection): GhostAxisRef | null {
    const selection = this.panel.axisSelection(direction);
    if (selection?.kind === 'standard') {
      return { kind: 'standard', axis: selection.axis };
    }
    if (selection?.kind === 'connector') {
      const { filePath, line, slot } = selection.option;
      return { kind: 'connector', filePath, line, ...(slot !== undefined ? { slot } : {}) };
    }
    const edit = this.editTarget;
    if (selection?.kind === 'keep' && edit) {
      const ref = edit.parsed.axisRefs?.[selection.sourceIndex];
      return ref ? { kind: 'connector', filePath: edit.filePath, line: ref.line, ...(ref.slot !== undefined ? { slot: ref.slot } : {}) } : null;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Viewport reflection
  // -------------------------------------------------------------------------

  /**
   * The pick channels, the mate dialog's: while the dialog is up every
   * assembly connector shows and is screen-pickable (an inserted part's on
   * hover, only to be refused), and clicks reach the viewer's pick path
   * rather than dragging parts. An armed axis slot shows the world axes as
   * pick targets too.
   */
  private syncViewport(): void {
    const controller = this.viewer.getAssemblyController();
    this.viewer.pickConnectors = this.armed;
    controller?.setMatePicking(this.armed, false);
    if (!this.armed) {
      controller?.setMatePickedConnectors([]);
      this.viewer.hideStandardAxes();
      return;
    }
    if (this.isAxisPicking) {
      this.viewer.showStandardAxes(this.onStandardAxisPick);
    } else {
      this.viewer.hideStandardAxes();
    }
  }

  /** A shown world axis was clicked — it lands in the armed direction's slot. */
  private readonly onStandardAxisPick = (axis: StandardAxisId): void => {
    if (!this.armed || !this.isAxisPicking) {
      return;
    }
    this.panel.selectStandardAxis(axis);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  };

  /** Repaint the target chips and the picks in the viewport. */
  private refresh(): void {
    if (!this.armed) {
      return;
    }
    this.panel.setTargets(this.targets.map(target => (target.kind === 'connector'
      ? ConnectorOptions.chip(target.option, { removable: true })
      : { label: `Current: ${target.label}`, removable: true })));
    this.refreshHighlight();
  }

  /**
   * The picked connectors — targets and axes — drawn opaque among the
   * translucent rest, and the chosen world axes lit.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    const connectorIds = this.targets.flatMap(t => (t.kind === 'connector' ? [t.option.id] : []));
    const standardAxes: StandardAxisId[] = [];
    for (const direction of this.panel.directions) {
      const selection = this.panel.axisSelection(direction);
      if (selection?.kind === 'standard') {
        standardAxes.push(selection.axis);
      } else if (selection?.kind === 'connector') {
        connectorIds.push(selection.option.id);
      }
    }
    this.viewer.setSelectedStandardAxes(standardAxes);
    this.viewer.getAssemblyController()?.setMatePickedConnectors(
      connectorIds.map(connectorId => ({ instanceId: WORLD_BODY_ID, connectorId })),
    );
  }
}

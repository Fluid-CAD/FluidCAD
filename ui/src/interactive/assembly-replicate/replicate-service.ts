import { ReplicatePanel, type ReplicateArmedCell, type ReplicateRowView } from './replicate-panel';
import { ConnectorPickMenu } from '../assembly-mate/connector-pick-menu';
import {
  connectorChipLabel,
  connectorRefFor,
  findInstanceByAddress,
  geometryChipLabel,
  previewConnectorRef,
  reresolveGeometry,
  reresolveSlot,
  resolveConnectorPick,
  resolveExposureCell,
  resolveSideChain,
  resolveWorldPick,
  worldChipLabel,
  type ConnectorSlotState,
  type GeometrySlotState,
  type WorldSlotState,
} from '../assembly-mate/side-resolve';
import {
  buildProvisionalSpec,
  outerTargets,
  sameSide,
  seedHasMates,
  seedMembership,
  type ReplicateSeedRef,
} from './replicate-columns';
import {
  applyAssemblyReplicate,
  classifyContactPick,
  type AssemblyReplicatePayload,
  type AssemblyReplicateSideRef,
} from '../../api';
import type { Viewer } from '../../viewer';
import type { SelectionModifiers } from '../../viewer';
import type {
  SerializedAssembly,
  SerializedAssemblyMate,
  SerializedAssemblyReplicate,
  SerializedReplicateSide,
  SubSelection,
} from '../../types';
import { WORLD_BODY_ID } from '../../solver';

/** What fills a target column or a row cell: the same three side kinds a mate takes. */
export type ReplicateCellState = ConnectorSlotState | WorldSlotState | GeometrySlotState;

/** One target column: its resolved side, the mate type that references it, and whether it varies per replica. */
type Column = {
  /** Stable across renders: statement address + name, so ON flags survive a re-render. */
  key: string;
  state: ReplicateCellState;
  mateType: SerializedAssemblyMate['type'];
  on: boolean;
};

/** One replica row: cells aligned with EVERY column (OFF columns stay null). */
type Row = { cells: (ReplicateCellState | null)[] };

/** The seed being replicated, with the stable address its statement anchors on. */
type SeedState = {
  ref: ReplicateSeedRef;
  name: string;
  filePath: string;
  /** The seed's own `insert()` line. */
  line: number;
};

/** The replicate statement an open dialog is editing. */
type EditTarget = {
  filePath: string;
  sourceLine: number;
  replicateId: string;
};

const MATE_TYPE_LABELS: Record<SerializedAssemblyMate['type'], string> = {
  'fastened': 'Fastened',
  'revolute': 'Revolute',
  'slider': 'Slider',
  'cylindrical': 'Cylindrical',
  'planar': 'Planar',
  'parallel': 'Parallel',
  'pin-slot': 'Pin-slot',
  'tangent': 'Tangent',
};

/**
 * The replicate tool: copies a mated instance or sub-assembly onto new
 * mate targets. Opened on a seed (parts-panel row menu, or the toolbar
 * button with a selection) or armed to pick one (toolbar without a
 * selection). The dialog lists the seed's outer mate targets as columns;
 * each row is one replica, its cells filled by clicking connector gizmos
 * (or, for tangent columns, faces/edges that already carry an exposure).
 * Picks fill left to right and auto-advance — a completed row starts the
 * next — and every complete row solves live as ghosted provisional
 * bodies. Apply writes the `replicate()` statement through
 * `/api/assembly-replicate`.
 *
 * The parts panel's "Edit replicate…" opens the same dialog seeded from
 * the payload's replicate record ({@link beginEdit}); Apply then
 * re-renders the statement in place.
 */
export class AssemblyReplicateService {
  private panel: ReplicatePanel;
  private pickMenu: ConnectorPickMenu;
  private armed = false;
  private seedPicking = false;
  private applying = false;
  private seed: SeedState | null = null;
  private editTarget: EditTarget | null = null;
  private columns: Column[] = [];
  private rows: Row[] = [];
  private armedCell: ReplicateArmedCell = null;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private hooks: {
      getAssembly: () => SerializedAssembly | null;
      /** The dialog opened — dismiss the transform gizmo / viewport selection. */
      onEnter?: () => void;
      onExit?: () => void;
    },
  ) {
    this.panel = new ReplicatePanel(container);
    this.pickMenu = new ConnectorPickMenu(container);
    this.panel.onApply = () => void this.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onToggleColumn = (col, on) => {
      const column = this.columns[col];
      if (!column) {
        return;
      }
      column.on = on;
      if (!on) {
        for (const row of this.rows) {
          row.cells[col] = null;
        }
      }
      if (this.armedCell && !this.columns[this.armedCell.col]?.on) {
        this.armedCell = this.firstEmptyCell(this.armedCell.row) ?? this.firstEmptyCell();
      }
      this.panel.setMessage(null);
      this.syncPanel();
      this.refreshPreview();
    };
    this.panel.onAddRow = () => {
      this.rows.push(this.emptyRow());
      this.armedCell = this.firstEmptyCell(this.rows.length - 1);
      this.syncPanel();
      this.refreshPreview();
    };
    this.panel.onRemoveRow = (row) => {
      this.rows.splice(row, 1);
      if (this.rows.length === 0) {
        this.rows.push(this.emptyRow());
      }
      this.armedCell = this.firstEmptyCell(Math.min(row, this.rows.length - 1)) ?? this.firstEmptyCell();
      this.panel.setMessage(null);
      this.syncPanel();
      this.refreshPreview();
    };
    this.panel.onArmCell = (row, col) => {
      if (!this.columns[col]?.on || !this.rows[row]) {
        return;
      }
      this.armedCell = { row, col };
      this.syncPanel();
    };
    this.panel.onClearCell = (row, col) => {
      if (!this.rows[row]) {
        return;
      }
      this.rows[row].cells[col] = null;
      this.armedCell = { row, col };
      this.panel.setMessage(null);
      this.syncPanel();
      this.refreshPreview();
    };
    this.panel.onFillSiblings = () => this.fillFromSiblings();
  }

  get isActive(): boolean {
    return this.armed || this.seedPicking;
  }

  /** The armed dialog (or the seed pick) owns viewport clicks in assembly mode. */
  get isPicking(): boolean {
    return this.armed || this.seedPicking;
  }

  /**
   * The toolbar button without a selection: open the dialog on its
   * seed-pick prompt; the next click on a part (or a sub-assembly member)
   * resolves the seed and arms the target cells.
   */
  armSeedPick(): void {
    if (this.armed || this.seedPicking) {
      this.exit();
    }
    this.seedPicking = true;
    this.panel.show(null);
    this.panel.setApplyEnabled(false);
    this.panel.setPreview(null);
    this.viewer.pickConnectors = false;
    this.hooks.onEnter?.();
  }

  /**
   * Open the dialog on a seed (create mode): its outer mate targets become
   * the columns (all ON), one empty row is armed, and every connector gizmo
   * is revealed for picking. Refuses with a message when the record has no
   * mates, lives inside a sub-assembly, or is itself a replica.
   */
  begin(ref: ReplicateSeedRef): void {
    if (this.applying) {
      return;
    }
    const seed = this.resolveSeed(ref);
    if ('error' in seed) {
      if (this.seedPicking) {
        this.panel.setMessage(seed.error);
      } else {
        this.armSeedPick();
        this.panel.setMessage(seed.error);
      }
      return;
    }
    if (this.armed) {
      this.exit();
    }
    this.seedPicking = false;
    this.armed = true;
    this.seed = seed;
    this.editTarget = null;
    this.columns = this.buildColumns(seed, null);
    this.rows = [this.emptyRow()];
    this.armedCell = this.firstEmptyCell(0);
    this.panel.show({ name: seed.name, edit: false });
    this.syncPanel();
    this.syncViewport();
    this.hooks.onEnter?.();
    this.refreshPreview();
  }

  /**
   * The parts panel's "Edit replicate…": open the dialog seeded from the
   * statement's record — columns ON iff the statement lists them, rows
   * from its cells (re-resolved to live scene ids), Apply rewriting the
   * statement in place.
   */
  beginEdit(record: SerializedAssemblyReplicate): void {
    if (this.applying) {
      return;
    }
    const location = record.sourceLocation;
    if (!location || record.owner) {
      return; // owned statements edit in their own file — the menu already gates this
    }
    const ref: ReplicateSeedRef = record.seed.instanceId !== undefined
      ? { kind: 'instance', id: record.seed.instanceId }
      : { kind: 'occurrence', id: record.seed.occurrenceId ?? '' };
    const seed = this.resolveSeed(ref);
    if ('error' in seed) {
      return;
    }
    if (this.armed || this.seedPicking) {
      this.exit();
    }
    this.armed = true;
    this.seed = seed;
    this.editTarget = { filePath: location.filePath, sourceLine: location.line, replicateId: record.replicateId };
    this.columns = this.buildColumns(seed, record);
    let problem: string | null = null;
    this.rows = record.rows.map((cells) => {
      const row = this.emptyRow();
      cells.forEach((side, j) => {
        const target = record.targets[j];
        const col = target ? this.columns.findIndex(c => sameSide(this.serialize(c.state), target)) : -1;
        if (col < 0) {
          return;
        }
        const state = this.resolveSerializedSide(side);
        if ('error' in state) {
          problem = problem ?? state.error;
          return;
        }
        row.cells[col] = state;
      });
      return row;
    });
    if (this.rows.length === 0) {
      this.rows.push(this.emptyRow());
    }
    this.armedCell = this.firstEmptyCell();
    this.panel.show({ name: seed.name, edit: true });
    this.panel.setMessage(problem);
    this.syncPanel();
    this.syncViewport();
    this.hooks.onEnter?.();
    this.refreshPreview();
  }

  exit(): void {
    if (!this.armed && !this.seedPicking) {
      return;
    }
    this.armed = false;
    this.seedPicking = false;
    this.seed = null;
    this.editTarget = null;
    this.columns = [];
    this.rows = [];
    this.armedCell = null;
    this.pickMenu.close();
    this.syncViewport();
    this.panel.hide();
    this.hooks.onExit?.();
  }

  /**
   * Routes viewport clicks while active. Seed-picking: a click on any
   * instance resolves the seed (its top-level occurrence for a
   * sub-assembly member). Armed: a connector pick fills the armed cell,
   * several gizmos under the cursor open the "which connector?" popover
   * first, and a face/edge pick fills a tangent column from its exposure.
   */
  handleClick(
    shapeId: string | null,
    sub: SubSelection,
    instanceId: string | null,
    pick?: Pick<SelectionModifiers, 'clientX' | 'clientY' | 'connectorCandidates'>,
  ): void {
    if (this.seedPicking) {
      if (instanceId) {
        this.pickSeed(instanceId);
      }
      return;
    }
    if (!this.armed) {
      return;
    }
    this.pickMenu.close();
    if (!shapeId || !sub) {
      return; // empty-space click keeps the picks
    }
    const armed = this.armedCell;
    if (!armed) {
      this.panel.setMessage('Add a copy first, then click its slot and pick a connector.');
      return;
    }
    const column = this.columns[armed.col];
    if (!column) {
      return;
    }
    if (column.state.kind === 'geometry') {
      if (sub.type === 'face' || sub.type === 'edge') {
        void this.handleExposurePick(shapeId, sub, instanceId);
      } else {
        this.panel.setMessage('This is a tangent mate: click a face or edge the part exposes with expose().');
      }
      return;
    }
    if (sub.type !== 'connector') {
      if (sub.type === 'face' || sub.type === 'edge') {
        this.panel.setMessage(
          'Click a connector gizmo (the small axis triad on the part). If the part has none there, add one with the Connector tool first.',
        );
      }
      return;
    }
    const candidates = pick?.connectorCandidates;
    if (candidates && candidates.length > 1 && pick?.clientX !== undefined && pick.clientY !== undefined) {
      this.openPickMenu(candidates, pick.clientX, pick.clientY);
      return;
    }
    this.pickCell(shapeId, instanceId);
  }

  /** A row click in the rail's Connectors section while picking fills the armed cell. */
  pickWorldConnector(connectorId: string): void {
    if (!this.armed) {
      return;
    }
    this.pickMenu.close();
    this.pickCell(connectorId, WORLD_BODY_ID);
  }

  /**
   * The parts panel's "Remove this replica": drop one row of the
   * statement (the last row removes the statement). Runs without the
   * dialog.
   */
  async removeReplica(record: SerializedAssemblyReplicate, row: number): Promise<{ success: boolean; reason?: string }> {
    if (!record.sourceLocation) {
      return { success: false, reason: 'The replicate statement has no source location — re-render and try again.' };
    }
    return applyAssemblyReplicate(record.sourceLocation.filePath, {
      removeRow: { sourceLine: record.sourceLocation.line, row },
    });
  }

  /**
   * Every assembly render lands here: scene ids were re-minted, so the
   * seed, the columns and every cell re-resolve through their stable
   * addresses; a pick whose statement is gone drops back to the prompt. A
   * render that switched to a part scene closes the dialog, and so does an
   * edit session whose statement no longer starts on the edited line.
   */
  handleSceneRendered(sceneKind: 'part' | 'assembly'): void {
    if (!this.armed && !this.seedPicking) {
      return;
    }
    if (sceneKind !== 'assembly') {
      this.exit();
      return;
    }
    if (this.seedPicking || !this.seed) {
      return;
    }
    const assembly = this.hooks.getAssembly();
    const seed = assembly ? this.refindSeed(assembly, this.seed) : null;
    if (!seed) {
      this.exit();
      return;
    }
    this.seed = seed;
    if (this.editTarget) {
      const fresh = assembly?.replicates?.find(r =>
        r.sourceLocation?.filePath === this.editTarget!.filePath
        && r.sourceLocation.line === this.editTarget!.sourceLine
        && !r.owner,
      );
      if (!fresh) {
        this.exit();
        return;
      }
      this.editTarget.replicateId = fresh.replicateId;
    }
    const previous = new Map(this.columns.map(c => [c.key, c.on]));
    this.columns = this.buildColumns(seed, null).map(c => ({ ...c, on: previous.get(c.key) ?? c.on }));
    let dropped = false;
    for (const row of this.rows) {
      row.cells = this.columns.map((column, j) => {
        const cell = row.cells[j] ?? null;
        if (!cell || !column.on) {
          return null;
        }
        const fresh = this.reresolveCell(cell);
        if (!fresh) {
          dropped = true;
        }
        return fresh;
      });
    }
    if (dropped) {
      this.panel.setMessage('The model re-rendered and one picked connector no longer exists. Pick it again.');
    }
    if (this.armedCell && (!this.rows[this.armedCell.row] || !this.columns[this.armedCell.col]?.on)) {
      this.armedCell = this.firstEmptyCell();
    }
    this.syncViewport();
    this.syncPanel();
    this.refreshPreview();
  }

  // ---------------------------------------------------------------------
  // Seed
  // ---------------------------------------------------------------------

  /** A clicked instance → the seed it belongs to: itself at root, else its top-level occurrence. */
  private pickSeed(instanceId: string): void {
    const assembly = this.hooks.getAssembly();
    const instance = assembly?.instances.find(i => i.instanceId === instanceId);
    if (!instance) {
      this.panel.setMessage('Could not tell which part you clicked. Re-render and try again.');
      return;
    }
    const owner = instance.owner ?? '';
    const ref: ReplicateSeedRef = owner
      ? { kind: 'occurrence', id: owner.split('/')[0] }
      : { kind: 'instance', id: instance.instanceId };
    this.begin(ref);
  }

  /** The seed's record and stable address, or why it can't be replicated from this file. */
  private resolveSeed(ref: ReplicateSeedRef): SeedState | { error: string } {
    const assembly = this.hooks.getAssembly();
    if (!assembly) {
      return { error: 'No assembly is rendered.' };
    }
    if (ref.kind === 'instance') {
      const instance = assembly.instances.find(i => i.instanceId === ref.id);
      if (!instance) {
        return { error: 'Could not find that part in the current render. Re-render and try again.' };
      }
      if (instance.owner) {
        return { error: `${instance.name} lives inside a sub-assembly. Replicate it from the file that inserts it.` };
      }
      if (instance.replica) {
        return { error: `${instance.name} is itself a replica. Replicate the original instead, or edit its replicate statement.` };
      }
      if (!instance.sourceLocation) {
        return { error: `${instance.name} has no source location, so its insert() cannot be referenced.` };
      }
      if (!seedHasMates(assembly, ref)) {
        return { error: `${instance.name} has no mates to replicate. Mate it first, then replicate it.` };
      }
      return { ref, name: instance.name, filePath: instance.sourceLocation.filePath, line: instance.sourceLocation.line };
    }
    const occurrence = assembly.occurrences?.find(o => o.occurrenceId === ref.id);
    if (!occurrence) {
      return { error: 'Could not find that sub-assembly in the current render. Re-render and try again.' };
    }
    if (occurrence.parentPath) {
      return { error: `${occurrence.name} lives inside a sub-assembly. Replicate it from the file that inserts it.` };
    }
    if (occurrence.replica) {
      return { error: `${occurrence.name} is itself a replica. Replicate the original instead, or edit its replicate statement.` };
    }
    if (!occurrence.sourceLocation) {
      return { error: `${occurrence.name} has no source location, so its insert() cannot be referenced.` };
    }
    if (!seedHasMates(assembly, ref)) {
      return { error: `${occurrence.name} has no mates to replicate. Mate it first, then replicate it.` };
    }
    return { ref, name: occurrence.name, filePath: occurrence.sourceLocation.filePath, line: occurrence.sourceLocation.line };
  }

  /** The seed in a fresh render (ids are counter-based, but a source edit may have moved it). */
  private refindSeed(assembly: SerializedAssembly, seed: SeedState): SeedState | null {
    if (seed.ref.kind === 'instance') {
      const instance = findInstanceByAddress(assembly, {
        instanceLine: seed.line, filePath: seed.filePath, owner: '', replicaRow: undefined,
      });
      if (!instance) {
        return null;
      }
      return { ...seed, ref: { kind: 'instance', id: instance.instanceId }, name: instance.name };
    }
    const occurrence = assembly.occurrences?.find(o =>
      o.parentPath === ''
      && !o.replica
      && o.sourceLocation?.line === seed.line
      && o.sourceLocation?.filePath === seed.filePath,
    );
    if (!occurrence) {
      return null;
    }
    return { ...seed, ref: { kind: 'occurrence', id: occurrence.occurrenceId }, name: occurrence.name };
  }

  // ---------------------------------------------------------------------
  // Columns and cells
  // ---------------------------------------------------------------------

  private buildColumns(seed: SeedState, record: SerializedAssemblyReplicate | null): Column[] {
    const assembly = this.hooks.getAssembly();
    if (!assembly) {
      return [];
    }
    const columns: Column[] = [];
    for (const target of outerTargets(assembly, seed.ref)) {
      const state = this.resolveSerializedSide(target.side);
      if ('error' in state) {
        continue;
      }
      const on = record ? record.targets.some(t => sameSide(t, target.side)) : true;
      columns.push({ key: cellKey(state), state, mateType: target.mateType, on });
    }
    return columns;
  }

  /** A serialized side (from the payload) → its live cell state. */
  private resolveSerializedSide(side: SerializedReplicateSide): ReplicateCellState | { error: string } {
    const assembly = this.hooks.getAssembly();
    const controller = this.viewer.getAssemblyController();
    if (side.kind === 'connector') {
      return resolveConnectorPick(assembly, controller, side.connectorId, side.instanceId);
    }
    if (side.kind === 'frame') {
      return resolveWorldPick(assembly, side.connectorId);
    }
    return resolveExposureCell(assembly, (id, name) => this.hasExposure(id, name), side.instanceId, side.exposeName);
  }

  private hasExposure(instanceId: string, exposeName: string): boolean {
    return this.viewer.getAssemblyController()?.getContactState(instanceId, exposeName) !== null;
  }

  private serialize(state: ReplicateCellState): SerializedReplicateSide {
    if (state.kind === 'connector') {
      return { kind: 'connector', instanceId: state.instanceId, connectorId: state.connectorId };
    }
    if (state.kind === 'world') {
      return { kind: 'frame', connectorId: state.connectorId };
    }
    return { kind: 'geometry', instanceId: state.instanceId, exposeName: state.exposeName };
  }

  private reresolveCell(cell: ReplicateCellState): ReplicateCellState | null {
    const assembly = this.hooks.getAssembly();
    if (cell.kind === 'geometry') {
      return reresolveGeometry(assembly, (id, name) => this.hasExposure(id, name), cell);
    }
    return reresolveSlot(assembly, this.viewer.getAssemblyController(), cell);
  }

  private emptyRow(): Row {
    return { cells: this.columns.map(() => null) };
  }

  /** The first empty ON cell — in `row` when given, else anywhere, scanning rows in order. */
  private firstEmptyCell(row?: number): ReplicateArmedCell {
    const rows = row === undefined ? this.rows.map((_, k) => k) : [row];
    for (const k of rows) {
      const cells = this.rows[k]?.cells;
      if (!cells) {
        continue;
      }
      for (let j = 0; j < this.columns.length; j++) {
        if (this.columns[j].on && cells[j] === null) {
          return { row: k, col: j };
        }
      }
    }
    return null;
  }

  private rowComplete(row: Row): boolean {
    return this.columns.every((c, j) => !c.on || row.cells[j] !== null);
  }

  private rowEmpty(row: Row): boolean {
    return this.columns.every((c, j) => !c.on || row.cells[j] === null);
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
      onPick: () => this.pickCell(candidate.connectorId, candidate.instanceId),
    }));
    this.pickMenu.show(clientX, clientY, items, () => controller?.setHighlightedConnector(null));
  }

  private candidateLabel(candidate: { instanceId: string; connectorId: string }): string {
    const assembly = this.hooks.getAssembly();
    if (candidate.instanceId === WORLD_BODY_ID) {
      const state = resolveWorldPick(assembly, candidate.connectorId);
      return 'error' in state ? `Assembly · ${candidate.connectorId}` : worldChipLabel(state);
    }
    const state = resolveConnectorPick(assembly, this.viewer.getAssemblyController(), candidate.connectorId, candidate.instanceId);
    if ('error' in state) {
      const instance = assembly?.instances.find(i => i.instanceId === candidate.instanceId);
      return `${instance?.name ?? candidate.instanceId} · ${this.viewer.getAssemblyController()?.getConnectorName(candidate.connectorId) ?? '?'}`;
    }
    return connectorChipLabel(state);
  }

  /** One resolved connector (part or assembly) into the armed cell. */
  private pickCell(connectorId: string, instanceId: string | null): void {
    const armed = this.armedCell;
    if (!this.armed || !armed || !this.seed) {
      return;
    }
    const assembly = this.hooks.getAssembly();
    const state = instanceId === WORLD_BODY_ID
      ? resolveWorldPick(assembly, connectorId)
      : resolveConnectorPick(assembly, this.viewer.getAssemblyController(), connectorId, instanceId);
    if ('error' in state) {
      this.panel.setMessage(state.error);
      return;
    }
    this.fillCell(armed, state);
  }

  /**
   * A face/edge pick for a tangent column: classify it through the server
   * and take the exposure that already serves the pick — replicate cells
   * reference existing exposures only.
   */
  private async handleExposurePick(
    shapeId: string,
    sub: { type: 'face' | 'edge'; index: number },
    instanceId: string | null,
  ): Promise<void> {
    const armed = this.armedCell;
    if (!armed || !instanceId) {
      this.panel.setMessage('Could not tell which part you clicked. Re-render and try again.');
      return;
    }
    const result = await classifyContactPick({ shapeId, sub: { type: sub.type, index: sub.index } });
    if (!this.armed) {
      return;
    }
    if ('error' in result) {
      this.panel.setMessage(result.error);
      return;
    }
    const matched = result.donor?.matched ?? null;
    if (!matched) {
      this.panel.setMessage(
        'That face or edge is not exposed. Copies can only attach to geometry the part already publishes with expose().',
      );
      return;
    }
    const state = resolveExposureCell(this.hooks.getAssembly(), (id, name) => this.hasExposure(id, name), instanceId, matched);
    if ('error' in state) {
      this.panel.setMessage(state.error);
      return;
    }
    this.fillCell(armed, state);
  }

  /** Validate a pick against its column and the seed, fill the cell, advance. */
  private fillCell(at: { row: number; col: number }, state: ReplicateCellState): void {
    const column = this.columns[at.col];
    const row = this.rows[at.row];
    if (!column || !row || !this.seed) {
      return;
    }
    const geometryColumn = column.state.kind === 'geometry';
    if (geometryColumn !== (state.kind === 'geometry')) {
      this.panel.setMessage(geometryColumn
        ? 'This is a tangent mate: click a face or edge the part exposes with expose().'
        : 'This mate needs a connector: click a connector gizmo, not a face or edge.');
      return;
    }
    const onSeed = seedMembership(this.seed.ref);
    if (state.kind !== 'world' && onSeed(state.instanceId)) {
      this.panel.setMessage(`${state.instanceName} is part of ${this.seedName()}. Pick a connector on another part.`);
      return;
    }
    // Any of the original's own targets (this column's or another's) would
    // put the copy back where the original sits.
    const picked = this.serialize(state);
    if (this.columns.some(c => sameSide(picked, this.serialize(c.state)))) {
      this.panel.setMessage(`${this.seedName()} already uses ${this.cellLabel(state)}. Pick a different connector for this copy.`);
      return;
    }
    row.cells[at.col] = state;
    this.panel.setMessage(null);
    this.advanceFrom(at);
    this.syncPanel();
    this.refreshPreview();
  }

  /**
   * After a cell fills: the row's next empty ON cell, else its first empty
   * one, else — the row is complete — the next row's first empty cell,
   * appending a fresh row when this was the last.
   */
  private advanceFrom(at: { row: number; col: number }): void {
    const row = this.rows[at.row];
    for (let j = at.col + 1; j < this.columns.length; j++) {
      if (this.columns[j].on && row.cells[j] === null) {
        this.armedCell = { row: at.row, col: j };
        return;
      }
    }
    const earlier = this.firstEmptyCell(at.row);
    if (earlier) {
      this.armedCell = earlier;
      return;
    }
    for (let k = at.row + 1; k < this.rows.length; k++) {
      const next = this.firstEmptyCell(k);
      if (next) {
        this.armedCell = next;
        return;
      }
    }
    this.rows.push(this.emptyRow());
    this.armedCell = this.firstEmptyCell(this.rows.length - 1);
  }

  // ---------------------------------------------------------------------
  // Fill from siblings
  // ---------------------------------------------------------------------

  /**
   * Candidate cells for a column: the other connectors on the target's own
   * instance (a part-connector column) or the other assembly connectors
   * (an assembly-connector column), skipping any a mate already uses.
   * Null for a tangent column — exposures have no sibling notion.
   */
  private siblingCandidates(column: Column): ReplicateCellState[] | null {
    const assembly = this.hooks.getAssembly();
    const controller = this.viewer.getAssemblyController();
    if (!assembly || !controller || column.state.kind === 'geometry') {
      return null;
    }
    const used = new Set<string>();
    for (const mate of assembly.mates) {
      for (const side of [mate.connectorA, mate.connectorB]) {
        if (side) {
          used.add(`${side.instanceId}\0${side.connectorId}`);
        }
      }
      for (const frame of [mate.frameA, mate.frameB]) {
        if (frame) {
          used.add(`${WORLD_BODY_ID}\0${frame.connectorId}`);
        }
      }
    }
    const out: ReplicateCellState[] = [];
    if (column.state.kind === 'world') {
      for (const connector of assembly.connectors ?? []) {
        if (connector.connectorId === column.state.connectorId || used.has(`${WORLD_BODY_ID}\0${connector.connectorId}`)) {
          continue;
        }
        const state = resolveWorldPick(assembly, connector.connectorId);
        if (!('error' in state)) {
          out.push(state);
        }
      }
      return out;
    }
    const instanceId = column.state.instanceId;
    for (const { connectorId } of controller.listInstanceConnectors(instanceId)) {
      if (connectorId === column.state.connectorId || used.has(`${instanceId}\0${connectorId}`)) {
        continue;
      }
      const state = resolveConnectorPick(assembly, controller, connectorId, instanceId);
      if (!('error' in state)) {
        out.push(state);
      }
    }
    return out;
  }

  private fillAvailable(): boolean {
    const on = this.columns.filter(c => c.on);
    if (on.length === 0) {
      return false;
    }
    return on.every((c) => {
      const candidates = this.siblingCandidates(c);
      return candidates !== null && candidates.length > 0;
    });
  }

  /**
   * Propose rows by pairing each ON column's unused sibling connectors in
   * declaration order (as many rows as the shortest list). Empty rows are
   * replaced; filled rows are kept and the proposals appended after them.
   */
  private fillFromSiblings(): void {
    const on = this.columns.map((c, j) => (c.on ? j : -1)).filter(j => j >= 0);
    const lists = on.map(j => this.siblingCandidates(this.columns[j]));
    if (on.length === 0 || lists.some(l => l === null || l.length === 0)) {
      this.panel.setMessage('Nothing to suggest: every other connector on those parts is already in use.');
      return;
    }
    const count = Math.min(...lists.map(l => l!.length));
    const kept = this.rows.filter(r => !this.rowEmpty(r));
    for (let k = 0; k < count; k++) {
      const row = this.emptyRow();
      on.forEach((j, i) => {
        row.cells[j] = lists[i]![k];
      });
      kept.push(row);
    }
    // A fresh armed row after the proposals, so picking can just continue.
    kept.push(this.emptyRow());
    this.rows = kept;
    this.armedCell = this.firstEmptyCell();
    this.panel.setMessage(null);
    this.syncPanel();
    this.refreshPreview();
  }

  // ---------------------------------------------------------------------
  // Panel, viewport, preview
  // ---------------------------------------------------------------------

  private cellLabel(state: ReplicateCellState): string {
    if (state.kind === 'connector') {
      return connectorChipLabel(state);
    }
    if (state.kind === 'world') {
      return `${state.connectorName} (assembly)`;
    }
    return geometryChipLabel(state);
  }

  private syncPanel(): void {
    this.panel.setColumns(this.columns.map(c => ({
      mate: MATE_TYPE_LABELS[c.mateType],
      target: this.cellLabel(c.state),
      geometry: c.state.kind === 'geometry',
      on: c.on,
    })));
    const rows: ReplicateRowView[] = this.rows.map((row, k) => ({
      number: k + 2,
      cells: row.cells.map(cell => (cell ? { label: this.cellLabel(cell) } : null)),
    }));
    this.panel.setRows(rows, this.armedCell);
    this.panel.setFillAvailable(this.fillAvailable());
    this.panel.setHint(this.hintText());
  }

  /** The original's name for messages (never the internal word "seed"). */
  private seedName(): string {
    return this.seed?.name ?? 'the original';
  }

  /**
   * The "what to do now" line: which copy and which mate the next click
   * fills, what the original uses there, and, once at least one copy is
   * complete, that Apply can stop here.
   */
  private hintText(): string | null {
    if (!this.seed || !this.columns.some(c => c.on)) {
      return null;
    }
    const ready = this.rows.filter(r => this.rowComplete(r)).length;
    const readyText = `${ready} ${ready === 1 ? 'copy' : 'copies'}`;
    const armed = this.armedCell;
    const column = armed ? this.columns[armed.col] : undefined;
    if (!armed || !column || this.rows[armed.row]?.cells[armed.col]) {
      return ready > 0
        ? `${readyText} ready. Apply adds ${ready === 1 ? 'it' : 'them'} to the assembly.`
        : 'Click a copy\'s slot, then click a connector in 3D.';
    }
    const what = column.state.kind === 'geometry' ? 'an exposed face or edge' : 'a connector on another part';
    const next = `Copy ${armed.row + 2}: click ${what} in the 3D view for its ${MATE_TYPE_LABELS[column.mateType]} mate.`;
    return ready > 0 ? `${next} Or Apply now to add ${readyText}.` : next;
  }

  /**
   * Arm/disarm the viewer channel + controller reveal: while a cell is
   * armed every connector gizmo shows (the user is scanning for targets on
   * other parts); the seed-pick prompt and a closed dialog reveal nothing.
   */
  private syncViewport(): void {
    const controller = this.viewer.getAssemblyController();
    this.viewer.pickConnectors = this.armed;
    controller?.setMatePicking(this.armed, true);
    if (!this.armed) {
      controller?.setProvisionalReplicas(null);
    }
  }

  /** The statement-preview text for one cell (display names stand in for bindings). */
  private previewRef(state: ReplicateCellState): string {
    if (state.kind === 'world') {
      return state.connectorName;
    }
    if (state.kind === 'geometry') {
      return `${state.instanceName}.features.${state.exposeName}`;
    }
    return previewConnectorRef(this.hooks.getAssembly(), state);
  }

  /** Every cell/column must resolve to the seed's file (the statement's file). */
  private crossFileConflict(): string | null {
    const seed = this.seed;
    if (!seed) {
      return null;
    }
    const fileOf = (state: ReplicateCellState): string | { error: string } => {
      if (state.kind === 'connector') {
        const chain = resolveSideChain(this.hooks.getAssembly(), state);
        return 'error' in chain ? chain : chain.filePath;
      }
      return state.filePath;
    };
    const check = (state: ReplicateCellState, what: string): string | null => {
      const file = fileOf(state);
      if (typeof file !== 'string') {
        return file.error;
      }
      if (file !== seed.filePath) {
        return `${what} lives in another file. Pick a connector on a part that ${seed.name}'s file inserts.`;
      }
      return null;
    };
    for (const column of this.columns) {
      if (!column.on) {
        continue;
      }
      const problem = check(column.state, this.cellLabel(column.state));
      if (problem) {
        return problem;
      }
    }
    for (const row of this.rows) {
      for (let j = 0; j < this.columns.length; j++) {
        const cell = row.cells[j];
        if (!cell || !this.columns[j].on) {
          continue;
        }
        const problem = check(cell, this.cellLabel(cell));
        if (problem) {
          return problem;
        }
      }
    }
    return null;
  }

  /**
   * Rows Apply would write: complete rows in order. An empty trailing row
   * is dropped silently; a partially filled row anywhere blocks with the
   * cell to fill.
   */
  private applicableRows(): { rows: Row[] } | { error: string } {
    const rows: Row[] = this.rows.filter(row => this.rowComplete(row));
    for (let k = 0; k < this.rows.length; k++) {
      const row = this.rows[k];
      if (this.rowComplete(row) || this.rowEmpty(row)) {
        continue;
      }
      const j = this.columns.findIndex((c, i) => c.on && row.cells[i] === null);
      const column = this.columns[j];
      return {
        error: `Copy ${k + 2} still needs a connector for its ${MATE_TYPE_LABELS[column.mateType]} mate (${this.cellLabel(column.state)}).`,
      };
    }
    return { rows };
  }

  private refreshPreview(): void {
    const controller = this.viewer.getAssemblyController();
    if (!this.armed || !this.seed) {
      return;
    }
    const assembly = this.hooks.getAssembly();
    // Picked connectors render opaque while the rest stay translucent —
    // re-sent every refresh because renders re-mint the scene ids.
    const pinned: { instanceId: string; connectorId: string }[] = [];
    const pin = (state: ReplicateCellState | null) => {
      if (!state || state.kind === 'geometry') {
        return;
      }
      pinned.push(state.kind === 'world'
        ? { instanceId: WORLD_BODY_ID, connectorId: state.connectorId }
        : { instanceId: state.instanceId, connectorId: state.connectorId });
    };
    for (const column of this.columns) {
      if (column.on) {
        pin(column.state);
      }
    }
    for (const row of this.rows) {
      row.cells.forEach((cell, j) => {
        if (this.columns[j]?.on) {
          pin(cell);
        }
      });
    }
    controller?.setMatePickedConnectors(pinned);

    const on = this.columns.filter(c => c.on);
    const applicable = this.applicableRows();
    const complete = 'rows' in applicable ? applicable.rows : this.rows.filter(r => this.rowComplete(r));
    const cellsOf = (row: Row) => this.columns.map((c, j) => (c.on ? row.cells[j] : null)).filter((c): c is ReplicateCellState => c !== null);
    const targets = on.map(c => this.previewRef(c.state)).join(', ');
    const rowsText = complete.map(r => `[${cellsOf(r).map(c => this.previewRef(c)).join(', ')}]`).join(', ');
    this.panel.setPreview(`replicate(${this.seed.name}, [${targets}], [${rowsText}]);`);

    let problem: string | null = null;
    if (on.length === 0) {
      problem = `Check at least one mate to re-attach. With none checked, every copy would land exactly on ${this.seedName()}.`;
    } else if ('error' in applicable) {
      problem = applicable.error;
    } else {
      problem = this.crossFileConflict();
    }
    if (problem) {
      this.panel.setMessage(problem);
    }
    this.panel.setApplyEnabled(problem === null && complete.length > 0 && !this.applying);

    if (assembly && controller && on.length > 0 && complete.length > 0) {
      controller.setProvisionalReplicas(buildProvisionalSpec(
        assembly,
        this.seed.ref,
        this.columns.map(c => ({ side: this.serialize(c.state), on: c.on })),
        complete.map(row => row.cells.map(cell => (cell ? this.serialize(cell) : null))),
      ));
    } else {
      controller?.setProvisionalReplicas(null);
    }
  }

  // ---------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------

  private sideRef(state: ReplicateCellState): AssemblyReplicateSideRef | { error: string } {
    if (state.kind === 'world') {
      return { connectorLine: state.connectorLine, connectorName: state.connectorName };
    }
    if (state.kind === 'geometry') {
      return {
        instanceLine: state.instanceLine,
        exposeName: state.exposeName,
        ...(state.replicaRow !== undefined ? { replicaRow: state.replicaRow } : {}),
      };
    }
    const chain = resolveSideChain(this.hooks.getAssembly(), state);
    if ('error' in chain) {
      return chain;
    }
    return connectorRefFor(state, chain);
  }

  /** The payload Apply posts, or the message blocking it. */
  buildPayload(): AssemblyReplicatePayload | { error: string } {
    const seed = this.seed;
    if (!seed) {
      return { error: 'Pick a seed first.' };
    }
    const on = this.columns.filter(c => c.on);
    if (on.length === 0) {
      return { error: `Check at least one mate to re-attach. With none checked, every copy would land exactly on ${this.seedName()}.` };
    }
    const applicable = this.applicableRows();
    if ('error' in applicable) {
      return applicable;
    }
    if (applicable.rows.length === 0) {
      return { error: 'Add at least one replica row and pick its targets.' };
    }
    const conflict = this.crossFileConflict();
    if (conflict) {
      return { error: conflict };
    }
    const targets: AssemblyReplicateSideRef[] = [];
    for (const column of on) {
      const ref = this.sideRef(column.state);
      if ('error' in ref) {
        return ref;
      }
      targets.push(ref);
    }
    const rows: AssemblyReplicateSideRef[][] = [];
    for (const row of applicable.rows) {
      const refs: AssemblyReplicateSideRef[] = [];
      for (let j = 0; j < this.columns.length; j++) {
        if (!this.columns[j].on) {
          continue;
        }
        const ref = this.sideRef(row.cells[j]!);
        if ('error' in ref) {
          return ref;
        }
        refs.push(ref);
      }
      rows.push(refs);
    }
    return { seed: { instanceLine: seed.line }, targets, rows };
  }

  private async apply(): Promise<void> {
    if (!this.armed || !this.seed || this.applying) {
      return;
    }
    const payload = this.buildPayload();
    if ('error' in payload) {
      this.panel.setMessage(payload.error);
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const target = this.editTarget;
      const result = await applyAssemblyReplicate(
        target?.filePath ?? this.seed.filePath,
        target ? { edit: { sourceLine: target.sourceLine, ...payload } } : { create: payload },
      );
      if (!result.success) {
        this.panel.setMessage(
          result.reason ?? (target ? 'Could not update the replicate statement.' : 'Could not add the replicate statement.'),
        );
        this.panel.setApplyEnabled(true);
        return;
      }
      // The committed statement re-renders with the real replicas at the
      // preview's poses; keep the ghosts on screen (but out of the solve)
      // until that render lands rather than snapping them away.
      this.viewer.getAssemblyController()?.commitProvisionalReplicas();
      this.exit();
    } finally {
      this.applying = false;
    }
  }
}

/** A cell's identity across renders: kind + statement address + name. */
function cellKey(state: ReplicateCellState): string {
  if (state.kind === 'connector') {
    return `c:${state.filePath}:${state.instanceLine}:${state.owner}:${state.replicaRow ?? ''}:${state.connectorName}`;
  }
  if (state.kind === 'world') {
    return `w:${state.filePath}:${state.connectorName}`;
  }
  return `g:${state.filePath}:${state.instanceLine}:${state.replicaRow ?? ''}:${state.exposeName}`;
}

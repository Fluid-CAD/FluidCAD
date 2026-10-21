import type {
  CatalogParamValue,
  ConfigurationEditResult,
  ConfigurationSourceTable,
  ConfigurationTableCommit,
  EdgeProperties,
  EditorHistoryResult,
  ExportRequestBody,
  FaceProperties,
  Material,
  MeasureEntityRef,
  MeasureResult,
  MoveToPartResult,
  PartProperties,
  RemoveFeaturePreview,
  RemoveFeatureResult,
  SetUnitResult,
  ShapeProperties,
  SourceLocation,
  SourceLocationParam,
  UserPreferences,
} from './api';
import type { LengthUnit } from './units/units';

/**
 * Source-editing commands only an editor-backed host can honor. A read-only
 * host (the browser viewer) exposes none of these; panels hide the
 * corresponding controls when `EngineClient.editor` is null.
 */
export interface EngineEditorClient {
  addBreakpoint(sourceLocation: SourceLocationParam): void;
  /**
   * Atomic document breakpoint edit: pause before `before` (a move takes
   * out the stops it passes — `remove: 'passed'` — and leaves later ones
   * pending), or with null and `'all'` continue to the end of history.
   */
  moveTimelineBreakpoint?(filePath: string, before: { line: number; column: number } | null, remove?: 'passed' | 'all'): Promise<{ success: boolean; reason?: string }>;
  /**
   * Reveal a source line. `revealEditor: false` is a passive navigation: an
   * editor that is hidden stays hidden (see {@link gotoSource} in api.ts).
   */
  gotoSource(sourceLocation: SourceLocationParam, opts?: { revealEditor?: boolean }): void;
  removeFeature(sourceLocation: SourceLocationParam): void;
  /**
   * What removing the feature would take along: every later statement that
   * references it, recursively. Analysis only — nothing is edited.
   */
  previewRemoveFeature(sourceLocation: SourceLocationParam): Promise<RemoveFeaturePreview>;
  /** Remove the feature and that whole dependant closure in one acked edit. */
  removeFeatureCascade(sourceLocation: SourceLocationParam): Promise<RemoveFeatureResult>;
  renameFeature(sourceLocation: SourceLocationParam, name: string | null): void;
  /**
   * Rename the `part(...)` statement at `sourceLocation`: its name, the
   * variable it is bound to and that variable's reads, in every file that
   * imports the part. Acked: resolves once the edits landed.
   */
  renamePart(sourceLocation: SourceLocationParam, name: string): Promise<SetUnitResult>;
  /** Step the editor's native undo history for the file at `filePath`. */
  undo(filePath: string): Promise<EditorHistoryResult>;
  /** Step the editor's native redo history for the file at `filePath`. */
  redo(filePath: string): Promise<EditorHistoryResult>;
  /**
   * Move the feature statements at `lines` into the `part(...)` at `part`.
   * With `dryRun` the server only analyzes: `needs` names the companion
   * statements the move must also include, and nothing touches the buffer.
   */
  moveToPart(
    filePath: string,
    lines: number[],
    part: { line: number; column: number },
    opts?: { dryRun?: boolean },
  ): Promise<MoveToPartResult>;
  /**
   * Make the part file at `filePath` declare `unit('…')` (a source edit the
   * host applies). Numbers are never converted — only the declaration.
   */
  setDocumentUnit(filePath: string, unit: LengthUnit | null): Promise<SetUnitResult>;
  /** Write the project unit (`fluidcad.json`) — what assemblies are measured in. */
  setProjectUnit(unit: LengthUnit): Promise<SetUnitResult>;
  /**
   * Set (null: remove) the `.material('id')` chain on the `part(...)`
   * statement at `sourceLocation`. Acked: resolves once the edit landed.
   */
  setPartMaterial(sourceLocation: SourceLocationParam, material: string | null): Promise<SetUnitResult>;
}

/**
 * The transport the read-only UI talks through instead of hardcoded
 * same-origin `/api` fetches. Desktop implements it over HTTP
 * (HttpEngineClient); the browser viewer implements it over a Web Worker
 * running `fluidcad/browser`. Scene commands are fire-and-forget — their
 * results arrive through the host's scene-rendered stream, which keeps
 * feeding panels exactly as today.
 */
export interface EngineClient {
  recompute(): void;
  /**
   * View-only rollback. `scope: 'part'` truncates only the target index's
   * enclosing part and keeps the rest of the scene fully rendered (the
   * timeline's one-click preview); without it the whole scene rolls back —
   * the exact-index semantics edit-session boundaries depend on. Hosts that
   * predate the scope simply ignore it and stay global.
   */
  rollback(index: number, scope?: 'part'): void;
  /**
   * Override a parameter's value. `body` names the part (or assembly) whose
   * `label` it is — the definition's `body` — so a label two parts declare
   * sets one part's only; a host that predates it reads the label alone.
   */
  setParam(label: string, value: unknown, body?: string): void;
  /**
   * Write a parameter's value into the source, where the configuration on
   * screen keeps it: the active row's cell, or on Default the `param()`
   * literal (`POST /api/params/value`). What the Parameters panel does with
   * a committed value on a host that edits source; a read-only host leaves
   * it out and the panel overrides values for the session instead
   * ({@link setParam}). `configuration` is the row the panel shows — a
   * session that moved on refuses the write. `value: null` clears the
   * row's cell, so the parameter inherits its literal again. Resolves once
   * the edit landed (one undo step), `success: false` with the `reason`
   * otherwise.
   */
  writeParam?(label: string, value: unknown, body?: string, configuration?: string): Promise<ConfigurationEditResult>;
  resetParams(): void;
  /**
   * Show the named `configurations()` row (`'Default'` for the literals):
   * the session's overrides go, the file re-renders with the row's cells
   * under the controls. Fire-and-forget like `setParam`.
   */
  selectConfiguration(name: string): void;
  /**
   * The `configurations()` row edits (`/api/configurations/add|rename|remove`):
   * each rewrites the table statement in source, so a read-only host leaves
   * them out and the Parameters panel offers none of its row actions. They
   * resolve once the edit landed — `success: false` with the refusal's
   * `reason` otherwise — and the re-render arrives on the scene stream.
   *
   * Add a row named `name` and select it; without `values`, the row holds
   * every parameter whose current value differs from its literal, each
   * part's in its own table. `part` is where a row with no cell goes (the
   * Part band's part).
   */
  addConfiguration?(
    name: string,
    values?: Record<string, CatalogParamValue>,
    part?: SourceLocation | null,
  ): Promise<ConfigurationEditResult>;
  /** Rename a row; the active name follows. */
  renameConfiguration?(from: string, to: string): Promise<ConfigurationEditResult>;
  /** Remove a row; the active one falls back to Default. */
  removeConfiguration?(name: string): Promise<ConfigurationEditResult>;
  /**
   * The tables as the file's live code writes them — one per body that has
   * one; which cells are literals and which are expressions — for the
   * Manage grid; null when the host cannot say.
   */
  getConfigurationTables?(): Promise<ConfigurationSourceTable[] | null>;
  /** The Manage grid's commit: renames, removals and cell edits as ONE rewrite of the file's tables. */
  commitConfigurationTable?(commit: ConfigurationTableCommit): Promise<ConfigurationEditResult>;
  getShapeProperties(shapeId: string): Promise<ShapeProperties | null>;
  getFaceProperties(shapeId: string, faceIndex: number, signal?: AbortSignal): Promise<FaceProperties | null>;
  getEdgeProperties(shapeId: string, edgeIndex: number, signal?: AbortSignal): Promise<EdgeProperties | null>;
  getMaterials(): Promise<Material[] | null>;
  /**
   * The aggregate over a part row's final solids (volume, area, centroid,
   * mass from its material). Optional: a host without it (the browser
   * viewer's worker client) leaves the Shape Properties panel's Part mode
   * without numbers.
   */
  getPartProperties?(partId: string): Promise<PartProperties | null>;
  measureEntities(entities: MeasureEntityRef[], signal?: AbortSignal): Promise<MeasureResult | null>;
  /** `POST /api/export` — a list of solids, or the whole assembly; see {@link ExportRequestBody}. */
  exportShapes(body: ExportRequestBody): Promise<Blob>;
  loadPreferences(): Promise<UserPreferences | null>;
  savePreference<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]): void;
  /** Editing affordances; null in read-only hosts. */
  readonly editor: EngineEditorClient | null;
}

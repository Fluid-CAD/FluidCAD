import type {
  EdgeProperties,
  EditorHistoryResult,
  ExportRequestBody,
  FaceProperties,
  Material,
  MeasureEntityRef,
  MeasureResult,
  MoveToPartResult,
  RemoveFeaturePreview,
  RemoveFeatureResult,
  SetUnitResult,
  ShapeProperties,
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
  setParam(label: string, value: unknown): void;
  resetParams(): void;
  getShapeProperties(shapeId: string): Promise<ShapeProperties | null>;
  getFaceProperties(shapeId: string, faceIndex: number, signal?: AbortSignal): Promise<FaceProperties | null>;
  getEdgeProperties(shapeId: string, edgeIndex: number, signal?: AbortSignal): Promise<EdgeProperties | null>;
  getMaterials(): Promise<Material[] | null>;
  measureEntities(entities: MeasureEntityRef[], signal?: AbortSignal): Promise<MeasureResult | null>;
  /** `POST /api/export` — a list of solids, or the whole assembly; see {@link ExportRequestBody}. */
  exportShapes(body: ExportRequestBody): Promise<Blob>;
  loadPreferences(): Promise<UserPreferences | null>;
  savePreference<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]): void;
  /** Editing affordances; null in read-only hosts. */
  readonly editor: EngineEditorClient | null;
}

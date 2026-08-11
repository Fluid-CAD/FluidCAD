import type {
  Material,
  MeasureEntityRef,
  MeasureResult,
  ShapeProperties,
  SourceLocationParam,
  UserPreferences,
} from './api';

/**
 * Source-editing commands only an editor-backed host can honor. A read-only
 * host (the browser viewer) exposes none of these; panels hide the
 * corresponding controls when `EngineClient.editor` is null.
 */
export interface EngineEditorClient {
  addBreakpoint(sourceLocation: SourceLocationParam): void;
  gotoSource(sourceLocation: SourceLocationParam): void;
  removeFeature(sourceLocation: SourceLocationParam): void;
  renameFeature(sourceLocation: SourceLocationParam, name: string | null): void;
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
  rollback(index: number): void;
  setParam(label: string, value: unknown): void;
  resetParams(): void;
  getShapeProperties(shapeId: string): Promise<ShapeProperties | null>;
  getMaterials(): Promise<Material[] | null>;
  measureEntities(entities: MeasureEntityRef[], signal?: AbortSignal): Promise<MeasureResult | null>;
  exportShapes(body: Record<string, unknown>): Promise<Blob>;
  loadPreferences(): Promise<UserPreferences | null>;
  savePreference<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]): void;
  /** Editing affordances; null in read-only hosts. */
  readonly editor: EngineEditorClient | null;
}

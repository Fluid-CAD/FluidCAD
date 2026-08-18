import {
  addBreakpoint,
  editorRedo,
  editorUndo,
  exportShapes,
  getEdgeProperties,
  getFaceProperties,
  getMaterials,
  getShapeProperties,
  gotoSource,
  loadPreferences,
  measureEntities,
  recompute,
  removeFeature,
  renameFeature,
  rollback,
  savePreference,
} from './api';
import type { EdgeProperties, EditorHistoryResult, FaceProperties, Material, MeasureEntityRef, MeasureResult, ShapeProperties, SourceLocationParam, UserPreferences } from './api';
import type { EngineClient, EngineEditorClient } from './engine-client';

class HttpEngineEditorClient implements EngineEditorClient {
  addBreakpoint(sourceLocation: SourceLocationParam): void {
    addBreakpoint(sourceLocation);
  }

  gotoSource(sourceLocation: SourceLocationParam): void {
    gotoSource(sourceLocation);
  }

  removeFeature(sourceLocation: SourceLocationParam): void {
    removeFeature(sourceLocation);
  }

  renameFeature(sourceLocation: SourceLocationParam, name: string | null): void {
    renameFeature(sourceLocation, name);
  }

  undo(filePath: string): Promise<EditorHistoryResult> {
    return editorUndo(filePath);
  }

  redo(filePath: string): Promise<EditorHistoryResult> {
    return editorRedo(filePath);
  }
}

/**
 * The desktop EngineClient: same-origin `/api` HTTP, results arriving over
 * the WebSocket scene-rendered stream — behavior identical to the direct
 * api.ts calls the panels made before the transport existed.
 */
export class HttpEngineClient implements EngineClient {
  readonly editor: EngineEditorClient = new HttpEngineEditorClient();

  recompute(): void {
    recompute();
  }

  rollback(index: number, scope?: 'part'): void {
    rollback(index, scope);
  }

  setParam(label: string, value: unknown): void {
    fetch('/api/set-param', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, value }),
    }).catch(err => console.error('Set param failed:', err));
  }

  resetParams(): void {
    fetch('/api/reset-params', { method: 'POST' })
      .catch(err => console.error('Reset params failed:', err));
  }

  getShapeProperties(shapeId: string): Promise<ShapeProperties | null> {
    return getShapeProperties(shapeId);
  }

  getFaceProperties(shapeId: string, faceIndex: number, signal?: AbortSignal): Promise<FaceProperties | null> {
    return getFaceProperties(shapeId, faceIndex, signal);
  }

  getEdgeProperties(shapeId: string, edgeIndex: number, signal?: AbortSignal): Promise<EdgeProperties | null> {
    return getEdgeProperties(shapeId, edgeIndex, signal);
  }

  getMaterials(): Promise<Material[] | null> {
    return getMaterials();
  }

  measureEntities(entities: MeasureEntityRef[], signal?: AbortSignal): Promise<MeasureResult | null> {
    return measureEntities(entities, signal);
  }

  exportShapes(body: Record<string, unknown>): Promise<Blob> {
    return exportShapes(body);
  }

  loadPreferences(): Promise<UserPreferences | null> {
    return loadPreferences();
  }

  savePreference<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]): void {
    savePreference(key, value);
  }
}

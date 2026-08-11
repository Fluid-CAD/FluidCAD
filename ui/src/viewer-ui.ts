/**
 * fluidcad/viewer-ui — the read-only viewer core as a library. Everything a
 * viewing host (the browser viewer shell) needs to display a rendered scene
 * and offer the non-editing panels, with all engine access routed through the
 * EngineClient interface: no `/api` fetch, no WebSocket, no editing service
 * reaches this graph. The desktop app composes these same classes in main.ts
 * with an HttpEngineClient.
 */
import './styles.css';

export { Viewer } from './viewer';
export type { SelectedEntity } from './viewer';
export { SceneContext } from './scene/scene-context';
export { themeColors, onThemeChange } from './scene/theme-colors';
export { viewerSettings, applyPreferences } from './scene/viewer-settings';

export { TimelinePanel } from './ui/timeline-panel';
export { ShapesPanel } from './ui/shapes-panel';
export { ParamsPanel } from './ui/params-panel';
export { ShapePropertiesModal } from './ui/shape-properties-modal';
export { ExportDialog } from './ui/export-dialog';
export { ErrorBanner } from './ui/error-banner';
export { LoadingOverlay } from './ui/loading-overlay';
export { captureScreenshot, captureScreenshotMulti } from './screenshot';

export type { EngineClient, EngineEditorClient } from './engine-client';
export type {
  Material,
  MeasureEntityRef,
  MeasureResult,
  ShapeProperties,
  SourceLocationParam,
  UserPreferences,
} from './api';
export type { SceneObjectRender, SceneObjectPart, UIParamDefinition, SubSelection } from './types';

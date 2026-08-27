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
export { TopBar } from './ui/top-bar';
export type { TopBarHandlers } from './ui/top-bar';
export { PanelRail } from './ui/panel-rail';
export type { PanelRailHandlers } from './ui/panel-rail';
export type { FileTab, FileTabsHandlers } from './editor/tabs';
export { PartsPanel } from './ui/parts-panel';
export type { PartsPanelOptions } from './ui/parts-panel';
export { JointsPanel } from './ui/joints-panel';
export type { JointsPanelOptions } from './ui/joints-panel';
export { DofStatus } from './ui/dof-status';
export type { DofStatusUpdate } from './ui/dof-status';
export { DragReadout } from './ui/drag-readout';
export { SelectionInfoOverlay } from './ui/selection-info-overlay';
export { MeasureController } from './ui/measure/measure-controller';
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
export type {
  SceneObjectRender,
  SceneObjectPart,
  UIParamDefinition,
  SubSelection,
  SerializedAssembly,
  SerializedAssemblyInstance,
  SerializedAssemblyMate,
  SerializedAssemblyOccurrence,
  RenderedInstance,
} from './types';

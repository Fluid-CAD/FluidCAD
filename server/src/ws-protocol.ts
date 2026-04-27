// ---------------------------------------------------------------------------
// IPC: Extension → Server messages
// ---------------------------------------------------------------------------

export type ProcessFileMessage = {
  type: 'process-file';
  filePath: string;
};

export type LiveUpdateMessage = {
  type: 'live-update';
  fileName: string;
  code: string;
};

export type RollbackMessage = {
  type: 'rollback';
  fileName: string;
  index: number;
};

export type ImportFileMessage = {
  type: 'import-file';
  workspacePath: string;
  fileName: string;
  data: string; // base64
};

export type HighlightShapeMessage = {
  type: 'highlight-shape';
  shapeId: string;
};

export type ClearHighlightMessage = {
  type: 'clear-highlight';
};

export type ShowShapePropertiesMessage = {
  type: 'show-shape-properties';
  shapeId: string;
};

export type ExportSceneMessage = {
  type: 'export-scene';
  shapeIds: string[];
  options: {
    format: 'step' | 'stl';
    includeColors?: boolean;
    resolution?: string;
    customLinearDeflection?: number;
    customAngularDeflectionDeg?: number;
  };
};

export type ExtensionMessage =
  | ProcessFileMessage
  | LiveUpdateMessage
  | RollbackMessage
  | ImportFileMessage
  | HighlightShapeMessage
  | ClearHighlightMessage
  | ShowShapePropertiesMessage
  | ExportSceneMessage;

// ---------------------------------------------------------------------------
// IPC: Server → Extension messages
// ---------------------------------------------------------------------------

export type ReadyMessage = {
  type: 'ready';
  port: number;
  url: string;
};

export type InitCompleteMessage = {
  type: 'init-complete';
  success: boolean;
  error?: string;
};

export type CompileError = {
  message: string;
  filePath?: string;
  sourceLocation?: { filePath: string; line: number; column: number };
};

export type SceneRenderedMessage = {
  type: 'scene-rendered';
  absPath: string;
  result: any[];
  rollbackStop: number;
  compileError?: CompileError;
};

export type ErrorMessage = {
  type: 'error';
  message: string;
};

export type ImportCompleteMessage = {
  type: 'import-complete';
  success: boolean;
};

export type InsertPointMessage = {
  type: 'insert-point';
  point: [number, number];
  sourceLocation: { line: number; column: number };
};

export type RemovePointMessage = {
  type: 'remove-point';
  point: [number, number];
  sourceLocation: { line: number; column: number };
};

export type SetPickPointsMessage = {
  type: 'set-pick-points';
  points: [number, number][];
  sourceLocation: { line: number; column: number };
};

export type ExportCompleteMessage = {
  type: 'export-complete';
  success: boolean;
  data?: string;
  fileName?: string;
  error?: string;
};

export type AddPickMessage = {
  type: 'add-pick';
  sourceLocation: { line: number; column: number };
};

export type RemovePickMessage = {
  type: 'remove-pick';
  sourceLocation: { line: number; column: number };
};

export type AddBreakpointMessage = {
  type: 'add-breakpoint';
  filePath: string;
  line: number;
};

export type ClearBreakpointsMessage = {
  type: 'clear-breakpoints';
};

export type GotoSourceMessage = {
  type: 'goto-source';
  filePath: string;
  line: number;
  column: number;
};

export type ServerToExtensionMessage =
  | ReadyMessage
  | InitCompleteMessage
  | SceneRenderedMessage
  | ErrorMessage
  | ImportCompleteMessage
  | InsertPointMessage
  | RemovePointMessage
  | SetPickPointsMessage
  | AddPickMessage
  | RemovePickMessage
  | AddBreakpointMessage
  | ClearBreakpointsMessage
  | GotoSourceMessage
  | ExportCompleteMessage;

// ---------------------------------------------------------------------------
// WebSocket: Server → UI messages
// ---------------------------------------------------------------------------

export type UISceneRenderedMessage = {
  type: 'scene-rendered';
  result: any[];
  absPath: string;
  rollbackStop?: number;
  breakpointHit?: boolean;
  compileError?: CompileError;
};

export type UIHighlightShapeMessage = {
  type: 'highlight-shape';
  shapeId: string;
};

export type UIClearHighlightMessage = {
  type: 'clear-highlight';
};

export type UIShowShapePropertiesMessage = {
  type: 'show-shape-properties';
  shapeId: string;
};

export type UIInitCompleteMessage = {
  type: 'init-complete';
  success: boolean;
  error?: string;
};

export type UIProcessingFileMessage = {
  type: 'processing-file';
};

export type UITakeScreenshotMessage = {
  type: 'take-screenshot';
  requestId: string;
  options: {
    width?: number;
    height?: number;
    showGrid?: boolean;
    showAxes?: boolean;
    transparent?: boolean;
    autoCrop?: boolean;
    margin?: number;
  };
};

export type ServerToUIMessage =
  | UIInitCompleteMessage
  | UIProcessingFileMessage
  | UISceneRenderedMessage
  | UIHighlightShapeMessage
  | UIClearHighlightMessage
  | UIShowShapePropertiesMessage
  | UITakeScreenshotMessage;

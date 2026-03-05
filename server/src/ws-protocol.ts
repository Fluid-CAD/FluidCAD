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

export type ExtensionMessage =
  | ProcessFileMessage
  | LiveUpdateMessage
  | RollbackMessage
  | ImportFileMessage
  | HighlightShapeMessage
  | ClearHighlightMessage
  | ShowShapePropertiesMessage;

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

export type SceneRenderedMessage = {
  type: 'scene-rendered';
  absPath: string;
  result: any[];
  rollbackStop: number;
};

export type ErrorMessage = {
  type: 'error';
  message: string;
};

export type ImportCompleteMessage = {
  type: 'import-complete';
  success: boolean;
};

export type ServerToExtensionMessage =
  | ReadyMessage
  | InitCompleteMessage
  | SceneRenderedMessage
  | ErrorMessage
  | ImportCompleteMessage;

// ---------------------------------------------------------------------------
// WebSocket: Server → UI messages
// ---------------------------------------------------------------------------

export type UISceneRenderedMessage = {
  type: 'scene-rendered';
  result: any[];
  absPath: string;
  rollbackStop?: number;
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

export type ServerToUIMessage =
  | UISceneRenderedMessage
  | UIHighlightShapeMessage
  | UIClearHighlightMessage
  | UIShowShapePropertiesMessage;

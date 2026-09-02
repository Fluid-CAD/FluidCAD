import * as vscode from 'vscode';

export type BreakpointEditResult = { newCode: string; breakpointLine: number | null };
export type CodeEditResult = { newCode: string };

async function postCodeEdit<T>(
  serverUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  logger: vscode.OutputChannel,
): Promise<T | null> {
  if (!serverUrl) {
    return null;
  }
  try {
    const response = await fetch(`${serverUrl}/api/code/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      logger.appendLine(`[code-api] ${endpoint} returned HTTP ${response.status}`);
      return null;
    }
    return (await response.json()) as T;
  } catch (err) {
    logger.appendLine(`[code-api] ${endpoint} failed: ${err}`);
    return null;
  }
}

export function addBreakpoint(serverUrl: string, code: string, referenceRow: number, logger: vscode.OutputChannel) {
  return postCodeEdit<BreakpointEditResult>(serverUrl, 'add-breakpoint', { code, referenceRow }, logger);
}

export function removeBreakpoint(serverUrl: string, code: string, line: number, logger: vscode.OutputChannel) {
  return postCodeEdit<BreakpointEditResult>(serverUrl, 'remove-breakpoint', { code, line }, logger);
}

export function toggleBreakpoint(serverUrl: string, code: string, cursorRow: number, logger: vscode.OutputChannel) {
  return postCodeEdit<BreakpointEditResult>(serverUrl, 'toggle-breakpoint', { code, cursorRow }, logger);
}

export function clearBreakpoints(serverUrl: string, code: string, logger: vscode.OutputChannel) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'clear-breakpoints', { code }, logger);
}

export function insertPoint(
  serverUrl: string, code: string, sourceLine: number, point: [number, number], logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'insert-point', { code, sourceLine, point }, logger);
}

export function removePoint(
  serverUrl: string, code: string, sourceLine: number, point: [number, number], logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'remove-point', { code, sourceLine, point }, logger);
}

export function addPick(serverUrl: string, code: string, sourceLine: number, logger: vscode.OutputChannel) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'add-pick', { code, sourceLine }, logger);
}

export function removePick(serverUrl: string, code: string, sourceLine: number, logger: vscode.OutputChannel) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'remove-pick', { code, sourceLine }, logger);
}

export function addGuide(serverUrl: string, code: string, sourceLine: number, logger: vscode.OutputChannel) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'add-guide', { code, sourceLine }, logger);
}

export function removeGuide(serverUrl: string, code: string, sourceLine: number, logger: vscode.OutputChannel) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'remove-guide', { code, sourceLine }, logger);
}

export function removeStatement(serverUrl: string, code: string, sourceLine: number, logger: vscode.OutputChannel) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'remove-statement', { code, sourceLine }, logger);
}

export function setFeatureName(
  serverUrl: string, code: string, sourceLine: number, name: string | null, logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'set-feature-name', { code, sourceLine, name }, logger);
}

export function insertLoad(serverUrl: string, code: string, fileName: string, logger: vscode.OutputChannel) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'insert-load', { code, fileName }, logger);
}

export function setPickPoints(
  serverUrl: string, code: string, sourceLine: number, points: [number, number][], logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'set-pick-points', { code, sourceLine, points }, logger);
}

export type InsertChainEdit = {
  ground?: boolean;
  name?: string | null;
  defaultName?: string;
  translate?: [number, number, number] | null;
};

export function updateInsertChain(
  serverUrl: string,
  code: string,
  sourceLine: number,
  edit: InsertChainEdit,
  logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(
    serverUrl, 'update-insert-chain', { code, sourceLine, edit }, logger,
  );
}

export function insertGeometry(
  serverUrl: string, code: string, sketchSourceLine: number, statement: string, logger: vscode.OutputChannel,
  newVariable: { name: string; initializer: string } | null = null,
) {
  return postCodeEdit<CodeEditResult>(
    serverUrl, 'insert-geometry',
    { code, sketchSourceLine, statement, newVariable },
    logger,
  );
}


export type SketchPositionEditPayload = {
  sourceLine: number;
  points?: { pointIndex: number; position: [number, number]; expected?: [number, number] }[];
  scalar?: { value: number; expected?: number };
};

/** Unlike the other transforms this one can refuse (drift guard) — the
 * refusal rides `error` beside the untouched code. */
export type SketchPositionsResult = { newCode: string; error?: string };

export function updateSketchPositions(
  serverUrl: string, code: string,
  edits: SketchPositionEditPayload[], logger: vscode.OutputChannel,
) {
  return postCodeEdit<SketchPositionsResult>(serverUrl, 'update-sketch-positions', { code, edits }, logger);
}

export function updateDimension(
  serverUrl: string, code: string, sourceLine: number, newValue: number, logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'update-dimension', { code, sourceLine, newValue }, logger);
}

export function updateDimensionExpression(
  serverUrl: string, code: string, sourceLine: number, expression: string, logger: vscode.OutputChannel,
  sketchSourceLine: number | null = null,
  newVariable: { name: string; initializer: string } | null = null,
  dimensionOffset = 0,
) {
  return postCodeEdit<CodeEditResult>(
    serverUrl, 'update-dimension-expression',
    { code, sourceLine, expression, sketchSourceLine, newVariable, dimensionOffset },
    logger,
  );
}

/**
 * `filePath` lets the server refuse an assembly file (422 → null here). A
 * null `unit` removes the file's declaration ("Same as project") — it is
 * sent as JSON null, which the route accepts, never dropped.
 */
export function setUnit(
  serverUrl: string, code: string, unit: string | null, filePath: string, logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'set-unit', { code, unit, filePath }, logger);
}

export function applyFeature(
  serverUrl: string, code: string, spec: unknown, logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult & { error?: string }>(serverUrl, 'apply-feature', { code, spec }, logger);
}


/**
 * Replace the entire contents of `doc` with `newCode` in a single workspace
 * edit. Returns true on success.
 */
export async function replaceDocument(doc: vscode.TextDocument, newCode: string): Promise<boolean> {
  if (doc.getText() === newCode) {
    return true;
  }
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    doc.lineAt(doc.lineCount - 1).range.end,
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, fullRange, newCode);
  return vscode.workspace.applyEdit(edit);
}

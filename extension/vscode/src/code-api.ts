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

export function setTrimTargets(
  serverUrl: string, code: string, sourceLine: number, args: string, logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'set-trim-targets', { code, sourceLine, args }, logger);
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


export function updatePosition(
  serverUrl: string, code: string, sourceLine: number, newPosition: [number, number], logger: vscode.OutputChannel,
  pointIndex: number = 0,
  oldPosition: [number, number] | null = null,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'update-position', { code, sourceLine, newPosition, pointIndex, oldPosition }, logger);
}

export function updatePointExpression(
  serverUrl: string, code: string, sourceLine: number,
  xExpr: string, yExpr: string, logger: vscode.OutputChannel,
  sketchSourceLine: number | null = null,
  newVariable: { name: string; initializer: string }[] | null = null,
  pointIndex = 0,
  oldPosition: [number, number] | null = null,
) {
  return postCodeEdit<CodeEditResult>(
    serverUrl, 'update-point-expression',
    { code, sourceLine, xExpr, yExpr, sketchSourceLine, newVariable, pointIndex, oldPosition },
    logger,
  );
}

export function setLinePosition(
  serverUrl: string, code: string, sourceLine: number,
  newStart: [number, number], newEnd: [number, number], logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'set-line-position', { code, sourceLine, newStart, newEnd }, logger);
}

export function setChainPositions(
  serverUrl: string, code: string, sourceLine: number,
  updates: { pointIndex: number; position: [number, number] }[], logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'set-chain-positions', { code, sourceLine, updates }, logger);
}

export function setRectDimensions(
  serverUrl: string, code: string, sourceLine: number,
  startPoint: [number, number] | null, width: number, height: number, logger: vscode.OutputChannel,
  oldStartPoint: [number, number] | null = null,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'set-rect-dimensions', { code, sourceLine, startPoint, width, height, oldStartPoint }, logger);
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
  dimensionCall: string | null = null,
  dimensionInsert = false,
  dimensionPoint: [number, number] | null = null,
) {
  return postCodeEdit<CodeEditResult>(
    serverUrl, 'update-dimension-expression',
    { code, sourceLine, expression, sketchSourceLine, newVariable, dimensionOffset, dimensionCall, dimensionInsert, dimensionPoint },
    logger,
  );
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

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

export function setPickPoints(
  serverUrl: string, code: string, sourceLine: number, points: [number, number][], logger: vscode.OutputChannel,
) {
  return postCodeEdit<CodeEditResult>(serverUrl, 'set-pick-points', { code, sourceLine, points }, logger);
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

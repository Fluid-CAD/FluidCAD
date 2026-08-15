import * as vscode from 'vscode';
import type { Client } from './client';
import * as codeApi from './code-api';
import { isFluidScriptFile } from './file-kind';

const BREAKPOINT_LINE = /^(\s*)breakpoint\s*\(\s*\)\s*;?\s*$/;

function lineHasBreakpoint(doc: vscode.TextDocument, line: number): boolean {
  if (line < 0 || line >= doc.lineCount) {
    return false;
  }
  return BREAKPOINT_LINE.test(doc.lineAt(line).text);
}

function addNativeBreakpoint(client: Client, uri: vscode.Uri, line: number): void {
  const existing = vscode.debug.breakpoints.find(b =>
    b instanceof vscode.SourceBreakpoint &&
    b.location.uri.fsPath === uri.fsPath &&
    b.location.range.start.line === line,
  );
  if (existing) {
    return;
  }
  const bp = new vscode.SourceBreakpoint(
    new vscode.Location(uri, new vscode.Position(line, 0)),
  );
  client.syncingBreakpoints = true;
  try {
    vscode.debug.addBreakpoints([bp]);
  } finally {
    client.syncingBreakpoints = false;
  }
}

function removeNativeBreakpoint(client: Client, uri: vscode.Uri, line: number): void {
  const toRemove = vscode.debug.breakpoints.filter(b =>
    b instanceof vscode.SourceBreakpoint &&
    b.location.uri.fsPath === uri.fsPath &&
    b.location.range.start.line === line,
  );
  if (toRemove.length === 0) {
    return;
  }
  client.syncingBreakpoints = true;
  try {
    vscode.debug.removeBreakpoints(toRemove);
  } finally {
    client.syncingBreakpoints = false;
  }
}

export function initDebugBreakpointSync(client: Client): void {
  client.context.subscriptions.push(
    vscode.debug.onDidChangeBreakpoints((event) => {
      if (client.syncingBreakpoints) {
        return;
      }
      for (const bp of event.added) {
        mirrorNativeBreakpoint(client, bp, true);
      }
      for (const bp of event.removed) {
        mirrorNativeBreakpoint(client, bp, false);
      }
    }),
  );
}

async function mirrorNativeBreakpoint(client: Client, bp: vscode.Breakpoint, added: boolean) {
  if (!(bp instanceof vscode.SourceBreakpoint)) {
    return;
  }
  const uri = bp.location.uri;
  if (!isFluidScriptFile(uri.fsPath)) {
    return;
  }
  const line = bp.location.range.start.line;
  const doc = await vscode.workspace.openTextDocument(uri);

  if (!added) {
    if (!lineHasBreakpoint(doc, line)) {
      return;
    }
    const result = await codeApi.removeBreakpoint(client.serverUrl, doc.getText(), line, client.logger);
    if (!result) {
      return;
    }
    await codeApi.replaceDocument(doc, result.newCode);
    return;
  }

  // Server resolves the authoritative insert line; if the click landed
  // elsewhere, move the native dot so it coincides with breakpoint().
  const result = await codeApi.addBreakpoint(client.serverUrl, doc.getText(), line, client.logger);
  if (!result || result.breakpointLine === null) {
    return;
  }
  const applied = await codeApi.replaceDocument(doc, result.newCode);
  if (!applied) {
    return;
  }
  if (result.breakpointLine !== line) {
    removeNativeBreakpoint(client, uri, line);
    addNativeBreakpoint(client, uri, result.breakpointLine);
  }
}

export async function toggleBreakpoint(client: Client) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isFluidScriptFile(editor.document.fileName)) {
    return;
  }
  const doc = editor.document;
  const cursorLine = editor.selection.active.line;

  // Capture native dots that the server-side toggle is about to invalidate so
  // we can mirror the change after the edit.
  const beforeBreakpoint = lineHasBreakpoint(doc, cursorLine)
    ? cursorLine
    : lineHasBreakpoint(doc, cursorLine + 1) ? cursorLine + 1 : null;

  const result = await codeApi.toggleBreakpoint(client.serverUrl, doc.getText(), cursorLine, client.logger);
  if (!result) {
    return;
  }
  const applied = await codeApi.replaceDocument(doc, result.newCode);
  if (!applied) {
    return;
  }

  if (beforeBreakpoint !== null && result.breakpointLine === null) {
    removeNativeBreakpoint(client, doc.uri, beforeBreakpoint);
  } else if (beforeBreakpoint === null && result.breakpointLine !== null) {
    addNativeBreakpoint(client, doc.uri, result.breakpointLine);
  }
}

export async function handleAddBreakpointAfterLine(client: Client, filePath: string, line: number) {
  let editor = vscode.window.visibleTextEditors.find(
    e => e.document.fileName === filePath,
  );
  if (!editor) {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
      preview: false,
    });
  }
  const doc = editor.document;
  if (doc.lineCount === 0) {
    return;
  }

  // sourceLocation.line is 1-indexed.
  const referenceRow = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
  const result = await codeApi.addBreakpoint(client.serverUrl, doc.getText(), referenceRow, client.logger);
  if (!result) {
    return;
  }
  const applied = await codeApi.replaceDocument(doc, result.newCode);
  if (!applied) {
    return;
  }
  if (result.breakpointLine !== null) {
    addNativeBreakpoint(client, doc.uri, result.breakpointLine);
  }
}

export async function handleClearBreakpoints(client: Client) {
  let editor = vscode.window.activeTextEditor;
  if (!editor || !isFluidScriptFile(editor.document.fileName)) {
    editor = vscode.window.visibleTextEditors.find(
      e => e.document.fileName === client.currentFileName,
    );
  }
  if (!editor) {
    return;
  }
  const doc = editor.document;

  // Snapshot current breakpoint lines so we can clear native dots after.
  const breakpointLines: number[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    if (BREAKPOINT_LINE.test(doc.lineAt(i).text)) {
      breakpointLines.push(i);
    }
  }
  if (breakpointLines.length === 0) {
    return;
  }

  const result = await codeApi.clearBreakpoints(client.serverUrl, doc.getText(), client.logger);
  if (!result) {
    return;
  }
  const applied = await codeApi.replaceDocument(doc, result.newCode);
  if (!applied) {
    return;
  }
  for (const line of breakpointLines) {
    removeNativeBreakpoint(client, doc.uri, line);
  }
}

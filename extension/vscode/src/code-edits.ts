import * as vscode from 'vscode';
import type { Client } from './client';
import * as codeApi from './code-api';

function findEditorForCurrentFile(client: Client): vscode.TextEditor | undefined {
  let editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.fileName !== client.currentFileName) {
    editor = vscode.window.visibleTextEditors.find(
      e => e.document.fileName === client.currentFileName,
    );
  }
  return editor;
}

export async function handleInsertPoint(client: Client, msg: { point: [number, number]; sourceLocation: { line: number } }) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.insertPoint(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.point, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleAddPick(client: Client, msg: { sourceLocation: { line: number } }) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    client.logger.appendLine(`[add-pick] No editor found for ${client.currentFileName}`);
    return;
  }
  const doc = editor.document;
  const result = await codeApi.addPick(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleRemovePick(client: Client, msg: { sourceLocation: { line: number } }) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    client.logger.appendLine(`[remove-pick] No editor found for ${client.currentFileName}`);
    return;
  }
  const doc = editor.document;
  const result = await codeApi.removePick(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleRemovePoint(client: Client, msg: { point: [number, number]; sourceLocation: { line: number } }) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.removePoint(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.point, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleGotoSource(
  _client: Client,
  msg: { filePath: string; line: number; column: number },
) {
  const uri = vscode.Uri.file(msg.filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.lineCount === 0) {
    return;
  }
  const row = Math.min(Math.max(msg.line - 1, 0), doc.lineCount - 1);
  const maxCol = doc.lineAt(row).text.length;
  const col = Math.min(Math.max(msg.column, 0), maxCol);
  const position = new vscode.Position(row, col);
  const range = new vscode.Range(position, position);
  const editor = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: true,
    preview: false,
    selection: range,
  });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export async function handleSetPickPoints(client: Client, msg: { points: [number, number][]; sourceLocation: { line: number } }) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.setPickPoints(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.points, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

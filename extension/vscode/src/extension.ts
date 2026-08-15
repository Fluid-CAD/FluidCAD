import * as vscode from 'vscode';
import { Client } from './client';
import { checkVersionMismatch } from './version-check';
import { isFluidScriptFile } from './file-kind';

let client: Client;
let currentOpenedFile: string | undefined;

async function initViewer(context: vscode.ExtensionContext, logger: vscode.OutputChannel) {
  if (!client) {
    try {
      vscode.window.showInformationMessage('FluidCAD extension is initializing...');
      client = new Client(context, logger);
      await client.init();
      vscode.window.showInformationMessage('FluidCAD extension initialized.');
    }
    catch (e: any) {
      vscode.window.showErrorMessage('Failed to initialize FluidCAD extension: ' + e.message);
      client = undefined;
    }
  }
  else {
    client.reveal();
  }
}

async function onDidChangeActiveTextEditor(editor: vscode.TextEditor, context: vscode.ExtensionContext, logger: vscode.OutputChannel) {
  if (!editor || !editor.document) {
    return;
  }

  if (editor.viewColumn === vscode.ViewColumn.Two) {
    logger.appendLine('FluidCAD file opened in column two, reopening in column one');
    // move it to column one
    await vscode.window.tabGroups.close(vscode.window.tabGroups.activeTabGroup.activeTab);
    await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One, false);
    return;
  }

  const isFluidFile = isFluidScriptFile(editor.document.fileName) && !editor.document.fileName.startsWith('init.js');
  console.log('Is FluidCAD file:', isFluidFile);
  if (!isFluidFile) {
    return;
  }

  if (currentOpenedFile === editor.document.fileName) {
    console.log('File already opened in viewer:', currentOpenedFile);
    return;
  }

  currentOpenedFile = editor.document.fileName;
  console.log('Active editor changed:', editor?.document.uri.toString());

  await initViewer(context, logger);

  if (editor.document.isDirty) {
    const fullText = editor.document.getText();
    client.updateLiveCode(editor.document.fileName, fullText);
  }
  else {
    client.processFile(editor.document.uri.fsPath);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const logger = vscode.window.createOutputChannel('FluidCAD');

  logger.appendLine('FluidCAD extension activated');

  checkVersionMismatch(context, logger);

  const editors = vscode.window.visibleTextEditors;

  console.log('Visible editors:', editors.map(e => e.document.uri.toString()));

  vscode.window.onDidChangeActiveTextEditor(async editor => {
    await onDidChangeActiveTextEditor(editor, context, logger);
  });

  const hasFluidFile = editors.some(e => isFluidScriptFile(e.document.fileName));

  // Only initialize eagerly if a FluidCAD script is already open; otherwise defer to onDidChangeActiveTextEditor
  if (hasFluidFile) {
    initViewer(context, logger).then(() => {
      for (const editor of editors) {
        if (isFluidScriptFile(editor.document.fileName)) {
          onDidChangeActiveTextEditor(editor, context, logger);
          break;
        }
      }
    });
  }
}

export function deactivate() {
  if (client) {
    client.dispose();
  }
}

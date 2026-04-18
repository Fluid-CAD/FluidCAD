import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import {
  initLiveRender,
  spawnServer,
  sendToServer,
  processFile as serverProcessFile,
  updateLiveCode as serverUpdateLiveCode,
  importFile as serverImportFile,
  exportFile as serverExportFile,
} from './server-process';
import { createWebviewPanel, revealPanel } from './webview';
import {
  initDebugBreakpointSync,
  toggleBreakpoint,
  handleAddBreakpointAfterLine,
  handleClearBreakpoints,
} from './breakpoints';
import {
  handleInsertPoint,
  handleAddPick,
  handleRemovePoint,
  handleSetPickPoints,
} from './code-edits';
import { updateDiagnostics } from './diagnostics';

export class Client {
  panel: vscode.WebviewPanel | undefined = undefined;
  serverProcess: ChildProcess | undefined;
  serverUrl: string = '';
  diagnosticCollection: vscode.DiagnosticCollection;
  pendingExportUri: vscode.Uri | undefined;
  syncingBreakpoints = false;

  currentSceneObjects: any[] = [];
  currentFileName: string = '';
  debounceTimer: NodeJS.Timeout | undefined;

  constructor(public context: vscode.ExtensionContext, public logger: vscode.OutputChannel) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('fluidcad');
    context.subscriptions.push(this.diagnosticCollection);
  }

  async init() {
    if (this.panel) {
      return;
    }

    this.context.subscriptions.push(vscode.commands.registerCommand(
      'fluidcad.show_scene',
      () => {
        if (!this.panel) {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            createWebviewPanel(this);
            this.processFile(editor.document.uri.fsPath);
          }
        }
      },
    ));

    this.context.subscriptions.push(vscode.commands.registerCommand(
      'fluidcad.import_file',
      () => serverImportFile(this),
    ));

    this.context.subscriptions.push(vscode.commands.registerCommand(
      'fluidcad.export_file',
      () => serverExportFile(this),
    ));

    this.context.subscriptions.push(vscode.commands.registerCommand(
      'fluidcad.toggle_breakpoint',
      () => toggleBreakpoint(this),
    ));

    initLiveRender(this);
    initDebugBreakpointSync(this);

    const folder = this.getActiveWorkspaceFolder();
    this.logger.appendLine(`Active workspace folder: ${folder}`);

    await spawnServer(this, folder);

    this.logger.appendLine('Server initialized successfully.');
  }

  async handleServerMessage(msg: any) {
    switch (msg.type) {
      case 'scene-rendered': {
        this.currentSceneObjects = msg.result;
        updateDiagnostics(this);
        this.logger.appendLine(`Scene rendered: ${msg.absPath}`);
        break;
      }
      case 'error': {
        this.logger.appendLine(`Server error: ${msg.message}`);
        vscode.window.showErrorMessage(`FluidCAD: ${msg.message}`);
        break;
      }
      case 'import-complete': {
        if (msg.success) {
          vscode.window.showInformationMessage('File imported successfully.');
        }
        break;
      }
      case 'insert-point': {
        handleInsertPoint(this, msg);
        break;
      }
      case 'clear-breakpoints': {
        handleClearBreakpoints(this).catch((err) => {
          this.logger.appendLine(`[clear-breakpoints] error: ${err?.stack || err}`);
        });
        break;
      }
      case 'add-breakpoint': {
        const filePath = typeof msg.filePath === 'string' ? msg.filePath : this.currentFileName;
        if (filePath && typeof msg.line === 'number') {
          handleAddBreakpointAfterLine(this, filePath, msg.line).catch((err) => {
            this.logger.appendLine(`[add-breakpoint] error: ${err?.stack || err}`);
          });
        }
        break;
      }
      case 'remove-point': {
        handleRemovePoint(this, msg);
        break;
      }
      case 'set-pick-points': {
        handleSetPickPoints(this, msg);
        break;
      }
      case 'add-pick': {
        handleAddPick(this, msg);
        break;
      }
      case 'export-complete': {
        if (msg.success && msg.data && this.pendingExportUri) {
          const buffer = Buffer.from(msg.data, 'base64');
          await vscode.workspace.fs.writeFile(this.pendingExportUri, buffer);
          vscode.window.showInformationMessage(`Exported to ${this.pendingExportUri.fsPath}`);
        } else {
          vscode.window.showErrorMessage(`Export failed: ${msg.error || 'Unknown error'}`);
        }
        this.pendingExportUri = undefined;
        break;
      }
    }
  }

  // Thin pass-throughs kept for use from extension.ts and helper modules.
  processFile(filePath: string) {
    serverProcessFile(this, filePath);
  }

  updateLiveCode(fileName: string, newCode: string) {
    serverUpdateLiveCode(this, fileName, newCode);
  }

  sendToServer(msg: any) {
    sendToServer(this, msg);
  }

  getActiveWorkspaceFolder() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0].uri.fsPath;
    }
  }

  reveal() {
    revealPanel(this);
  }

  dispose() {
    this.panel?.dispose();
    this.serverProcess?.kill();
  }
}

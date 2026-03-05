import * as vscode from 'vscode';
import { join } from 'path';
import { fork, ChildProcess } from 'child_process';
import { SceneHistoryProvider, SceneShapesProvider } from './graph';

export class Client {
  panel: vscode.WebviewPanel | undefined = undefined;

  private serverProcess: ChildProcess | undefined;
  private serverUrl: string = '';

  currentSceneObjects: any[] = [];
  rollbackStop = -1;
  private currentFileName: string = '';

  constructor(private context: vscode.ExtensionContext, private logger: vscode.OutputChannel) {
  }

  async init() {
    if (this.panel) {
      return;
    }

    this.context.subscriptions.push(vscode.commands.registerCommand(
      'fluidcad.rollback',
      async (obj) => {
        const index = this.currentSceneObjects.indexOf(obj);
        await this.rollback(index);
      }
    ));

    this.context.subscriptions.push(vscode.commands.registerCommand(
      'fluidcad.show_scene',
      () => {
        if (!this.panel) {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            this.createWebviewPanel();
            this.processFile(editor.document.uri.fsPath);
          }
        }
      }
    ));

    this.context.subscriptions.push(vscode.commands.registerCommand(
      'fluidcad.import_file',
      () => this.importFile()
    ));

    this.context.subscriptions.push(vscode.commands.registerCommand(
      'fluidcad.highlight_shape',
      (shapeId: string) => {
        this.highlightShape(shapeId);
      }
    ));

    this.context.subscriptions.push(vscode.commands.registerCommand(
      'fluidcad.shape_properties',
      (item: any) => {
        this.sendToServer({ type: 'show-shape-properties', shapeId: item.shapeId });
      }
    ));

    vscode.window.registerFileDecorationProvider({
      provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme === 'fluidcad') {
          const decoration: vscode.FileDecoration = {
          };

          const parts = uri.path.split('/');
          const visible = parts[1] === 'true';
          const fromCache = parts[2] === 'true';
          const hasError = parts[3] === 'true';
          const isCurrent = parts[4] === 'true';

          if (!visible) {
            decoration.color = new vscode.ThemeColor('disabledForeground');
          }

          if (fromCache) {
            decoration.badge = '✓';
            decoration.tooltip = 'Cached';
          }
          else {
            decoration.badge = '↺';
            decoration.tooltip = 'Computed';
          }

          if (hasError) {
            decoration.badge = '⨯';
            decoration.color = new vscode.ThemeColor('problemsErrorIcon.foreground');
          }

          if (isCurrent) {
            decoration.badge = '←' + (decoration.badge || '');
            if (!hasError) {
              decoration.color = new vscode.ThemeColor('charts.blue');
            }
          }

          return decoration;
        }
      }
    });

    this.initLiveRender();

    const folder = this.getActiveWorkspaceFolder();
    this.logger.appendLine(`Active workspace folder: ${folder}`);

    await this.spawnServer(folder);

    this.logger.appendLine('Server initialized successfully.');
  }

  private initLiveRender() {
    let debounceTimer: NodeJS.Timeout | undefined;

    const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document === event.document && activeEditor.document.fileName.endsWith('.fluid.js')) {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
          const fullText = event.document.getText();
          this.updateLiveCode(activeEditor.document.fileName, fullText);
          debounceTimer = undefined;
        }, 300);
      }
    });

    this.context.subscriptions.push(disposable);
  }

  private createWebviewPanel() {
    this.panel = vscode.window.createWebviewPanel(
      'fluidcadEditor.fluidjs',
      'FluidCAD Editor',
      vscode.ViewColumn.Two,
      {
        retainContextWhenHidden: false,
        enableScripts: true
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.html = this.getHTML();
  }

  private async spawnServer(workspacePath: string): Promise<void> {
    const serverEntry = join(this.context.extensionUri.fsPath, '..', '..', 'server', 'src', 'index.ts');

    const port = 3100 + Math.floor(Math.random() * 900);

    this.logger.appendLine(`Spawning server on port ${port}: ${serverEntry}`);

    this.serverProcess = fork(serverEntry, [], {
      env: {
        ...process.env,
        FLUIDCAD_SERVER_PORT: String(port),
        FLUIDCAD_WORKSPACE_PATH: workspacePath,
      },
      execArgv: ['--experimental-transform-types', '--no-warnings'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    this.serverProcess.stdout?.on('data', (data) => {
      this.logger.appendLine(`[server] ${data.toString().trim()}`);
    });

    this.serverProcess.stderr?.on('data', (data) => {
      this.logger.appendLine(`[server:err] ${data.toString().trim()}`);
    });

    // Listen for all IPC messages from server
    this.serverProcess.on('message', (msg: any) => {
      this.handleServerMessage(msg);
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 30000);

      const onMessage = (msg: any) => {
        if (msg.type === 'ready') {
          this.serverUrl = msg.url;
          this.logger.appendLine(`Server ready at ${this.serverUrl}`);
          this.createWebviewPanel();
        }
        else if (msg.type === 'init-complete') {
          clearTimeout(timeout);
          if (msg.success) {
            resolve();
          } else {
            reject(new Error(msg.error || 'Server init failed'));
          }
        }
      };

      this.serverProcess!.on('message', onMessage);

      this.serverProcess!.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.serverProcess!.on('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });
  }

  private handleServerMessage(msg: any) {
    switch (msg.type) {
      case 'scene-rendered': {
        this.currentSceneObjects = msg.result;
        this.rollbackStop = msg.rollbackStop;
        this.renderSceneGraph();
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
    }
  }

  private sendToServer(msg: any) {
    if (this.serverProcess?.connected) {
      this.serverProcess.send(msg);
    } else {
      this.logger.appendLine('Server process not connected, cannot send message');
    }
  }

  public async processFile(filePath: string) {
    this.currentFileName = filePath;
    this.sendToServer({
      type: 'process-file',
      filePath,
    });
  }

  public async updateLiveCode(fileName: string, newCode: string) {
    this.sendToServer({
      type: 'live-update',
      fileName,
      code: newCode,
    });
  }

  async rollback(index: number) {
    if (index < 0 || index >= this.currentSceneObjects.length) {
      this.logger.appendLine(`Invalid rollback index: ${index}`);
      return;
    }

    const obj = this.currentSceneObjects[index];
    if (obj.isContainer) {
      index += 1;
    }

    this.sendToServer({
      type: 'rollback',
      fileName: this.currentFileName,
      index,
    });
  }

  async importFile() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'STEP Files': ['step', 'stp'] },
      title: 'Import STEP File'
    });

    if (!uris || uris.length === 0) {
      return;
    }

    const uri = uris[0];
    const data = await vscode.workspace.fs.readFile(uri);
    const fileName = uri.fsPath.split('/').pop() || uri.fsPath;
    const workspacePath = this.getActiveWorkspaceFolder();

    this.logger.appendLine(`Importing file: ${fileName}`);

    this.sendToServer({
      type: 'import-file',
      workspacePath,
      fileName,
      data: Buffer.from(data).toString('base64'),
    });
  }

  highlightShape(shapeId: string) {
    this.sendToServer({
      type: 'highlight-shape',
      shapeId,
    });
  }

  clearHighlight() {
    this.sendToServer({
      type: 'clear-highlight',
    });
  }

  // ---------------------------------------------------------------------------
  // Tree views (fed by server data via IPC)
  // ---------------------------------------------------------------------------

  renderSceneGraph() {
    vscode.window.createTreeView('fluidcad.scene_history', {
      treeDataProvider: new SceneHistoryProvider(this.context, this.currentSceneObjects, this.rollbackStop)
    });

    const shapesTree = vscode.window.createTreeView('fluidcad.scene_shapes', {
      treeDataProvider: new SceneShapesProvider(this.context, this.currentSceneObjects)
    });

    shapesTree.onDidChangeSelection(e => {
      if (e.selection.length === 0) {
        this.clearHighlight();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Webview HTML (iframe to server)
  // ---------------------------------------------------------------------------

  getHTML(): string {
    const nonce = this.getNonce();

    return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://localhost:*; style-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>FluidCAD</title>
        <style nonce="${nonce}">
        body {
          margin: 0;
          padding: 0;
        }
        iframe {
          width: 100%;
          height: 100vh;
          border: none;
        }
        </style>
			</head>
			<body>
				<iframe src="${this.serverUrl}"></iframe>
			</body>
			</html>
    `;
  }

  getActiveWorkspaceFolder() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0].uri.fsPath;
    }
  }

  reveal() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two, true);
    }
  }

  dispose() {
    this.panel?.dispose();
    this.serverProcess?.kill();
  }

  getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}

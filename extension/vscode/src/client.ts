import * as vscode from 'vscode';
import { join } from 'path';
import { fork, ChildProcess } from 'child_process';
import { SceneHistoryProvider, SceneShapesProvider } from './graph';

export class Client {
  panel: vscode.WebviewPanel | undefined = undefined;

  private serverProcess: ChildProcess | undefined;
  private serverUrl: string = '';
  private diagnosticCollection: vscode.DiagnosticCollection;

  currentSceneObjects: any[] = [];
  rollbackStop = -1;
  private currentFileName: string = '';

  constructor(private context: vscode.ExtensionContext, private logger: vscode.OutputChannel) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('fluidcad');
    context.subscriptions.push(this.diagnosticCollection);
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

        if (obj.sourceLocation) {
          this.revealSourceLocation(obj.sourceLocation);
        }
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

  private debounceTimer: NodeJS.Timeout | undefined;

  private initLiveRender() {
    const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      if (!doc.fileName.endsWith('.fluid.js')) {
        return;
      }

      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(() => {
        this.updateLiveCode(doc.fileName, doc.getText());
        this.debounceTimer = undefined;
      }, 300);
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
    let serverEntry: string;
    try {
      serverEntry = require.resolve('fluidcad/server');
    } catch {
      serverEntry = join(this.context.extensionUri.fsPath, '..', '..', 'server', 'src', 'index.ts');
    }

    const port = 3100 + Math.floor(Math.random() * 900);

    this.logger.appendLine(`Spawning server on port ${port}: ${serverEntry}`);

    const isTs = serverEntry.endsWith('.ts');
    const execArgv = isTs ? ['--experimental-transform-types', '--no-warnings'] : [];

    this.serverProcess = fork(serverEntry, [], {
      env: {
        ...process.env,
        FLUIDCAD_SERVER_PORT: String(port),
        FLUIDCAD_WORKSPACE_PATH: workspacePath,
      },
      execArgv,
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
        this.updateDiagnostics();
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
        this.handleInsertPoint(msg);
        break;
      }
      case 'remove-point': {
        this.handleRemovePoint(msg);
        break;
      }
      case 'set-pick-points': {
        this.handleSetPickPoints(msg);
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
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
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

  private async handleInsertPoint(msg: any) {
    const { point, sourceLocation } = msg;
    const line = sourceLocation.line - 1;
    const pointText = `[${point[0]}, ${point[1]}]`;

    // Find the editor for the current file. activeTextEditor may be undefined
    // when the webview panel has focus, so search visibleTextEditors instead.
    let editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.fileName !== this.currentFileName) {
      editor = vscode.window.visibleTextEditors.find(
        e => e.document.fileName === this.currentFileName
      );
    }
    if (!editor) {
      return;
    }

    if (line < 0 || line >= editor.document.lineCount) {
      return;
    }

    const lineText = editor.document.lineAt(line).text;

    const closeParen = lineText.lastIndexOf(')');
    if (closeParen < 0) {
      return;
    }

    const openParen = lineText.lastIndexOf('(', closeParen);
    if (openParen < 0) {
      return;
    }

    const between = lineText.substring(openParen + 1, closeParen).trim();
    const prefix = between.length > 0 ? ', ' : '';

    const pos = new vscode.Position(line, closeParen);

    const applied = await editor.edit(b => b.insert(pos, `${prefix}${pointText}`));
    if (applied) {
      this.updateLiveCode(editor.document.fileName, editor.document.getText());
    }
  }

  private async handleRemovePoint(msg: any) {
    const { point, sourceLocation } = msg;
    const line = sourceLocation.line - 1;

    let editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.fileName !== this.currentFileName) {
      editor = vscode.window.visibleTextEditors.find(
        e => e.document.fileName === this.currentFileName
      );
    }
    if (!editor) {
      return;
    }

    if (line < 0 || line >= editor.document.lineCount) {
      return;
    }

    const lineText = editor.document.lineAt(line).text;

    // Find the last .pick(...) or standalone (...) call on the line
    const closeParen = lineText.lastIndexOf(')');
    if (closeParen < 0) {
      return;
    }

    const openParen = lineText.lastIndexOf('(', closeParen);
    if (openParen < 0) {
      return;
    }

    const argsStr = lineText.substring(openParen + 1, closeParen);

    // Parse all [x, y] point arguments
    const pointPattern = /\[([^\]]+)\]/g;
    const matches = [...argsStr.matchAll(pointPattern)];

    if (matches.length === 0) {
      return;
    }

    // Find the point closest to the clicked location
    let bestIndex = 0;
    let bestDist = Infinity;
    for (let i = 0; i < matches.length; i++) {
      const parts = matches[i][1].split(',').map(s => parseFloat(s.trim()));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        const dx = parts[0] - point[0];
        const dy = parts[1] - point[1];
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
        }
      }
    }

    // Calculate the range to delete (including surrounding comma + whitespace)
    const match = matches[bestIndex];
    const matchStart = openParen + 1 + match.index!;
    const matchEnd = matchStart + match[0].length;

    let deleteStart: number;
    let deleteEnd: number;

    if (matches.length === 1) {
      // Only point — just remove it
      deleteStart = matchStart;
      deleteEnd = matchEnd;
    } else if (bestIndex === 0) {
      // First point — remove trailing ", "
      deleteStart = matchStart;
      deleteEnd = matchEnd;
      const rest = lineText.substring(deleteEnd);
      const commaMatch = rest.match(/^,\s*/);
      if (commaMatch) {
        deleteEnd += commaMatch[0].length;
      }
    } else {
      // Non-first point — remove leading ", "
      const before = lineText.substring(0, matchStart);
      const commaMatch = before.match(/,\s*$/);
      deleteStart = commaMatch ? matchStart - commaMatch[0].length : matchStart;
      deleteEnd = matchEnd;
    }

    const range = new vscode.Range(
      new vscode.Position(line, deleteStart),
      new vscode.Position(line, deleteEnd),
    );


    const applied = await editor.edit(b => b.delete(range));
    if (applied) {
      this.updateLiveCode(editor.document.fileName, editor.document.getText());
    }
  }

  private async handleSetPickPoints(msg: any) {
    const { points, sourceLocation } = msg;
    const line = sourceLocation.line - 1;

    let editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.fileName !== this.currentFileName) {
      editor = vscode.window.visibleTextEditors.find(
        e => e.document.fileName === this.currentFileName
      );
    }
    if (!editor) {
      return;
    }

    if (line < 0 || line >= editor.document.lineCount) {
      return;
    }

    const lineText = editor.document.lineAt(line).text;

    const closeParen = lineText.lastIndexOf(')');
    if (closeParen < 0) {
      return;
    }

    const openParen = lineText.lastIndexOf('(', closeParen);
    if (openParen < 0) {
      return;
    }

    const newArgs = (points as [number, number][])
      .map(p => `[${p[0]}, ${p[1]}]`)
      .join(', ');

    const range = new vscode.Range(
      new vscode.Position(line, openParen + 1),
      new vscode.Position(line, closeParen),
    );


    const applied = await editor.edit(b => b.replace(range, newArgs));
    if (applied) {
      this.updateLiveCode(editor.document.fileName, editor.document.getText());
    }
  }

  private async revealSourceLocation(loc: { filePath: string; line: number; column: number }) {
    const uri = vscode.Uri.file(loc.filePath);
    const line = Math.max(0, loc.line - 1);
    const col = Math.max(0, loc.column - 1);
    const position = new vscode.Position(line, col);
    const range = new vscode.Range(position, position);

    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      selection: range,
    });
  }

  private updateDiagnostics() {
    this.diagnosticCollection.clear();

    const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

    for (const obj of this.currentSceneObjects) {
      if (obj.hasError && obj.errorMessage && obj.sourceLocation) {
        const loc = obj.sourceLocation;
        const line = Math.max(0, loc.line - 1);
        const col = Math.max(0, loc.column - 1);
        const range = new vscode.Range(line, col, line, Number.MAX_SAFE_INTEGER);

        const diagnostic = new vscode.Diagnostic(
          range,
          obj.errorMessage,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = 'FluidCAD';

        const filePath = loc.filePath;
        if (!diagnosticsByFile.has(filePath)) {
          diagnosticsByFile.set(filePath, []);
        }
        diagnosticsByFile.get(filePath)!.push(diagnostic);
      }
    }

    for (const [filePath, diagnostics] of diagnosticsByFile) {
      this.diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
    }
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

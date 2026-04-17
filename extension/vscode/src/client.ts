import * as vscode from 'vscode';
import { join } from 'path';
import { fork, ChildProcess } from 'child_process';

const BREAKPOINT_LINE = /^(\s*)breakpoint\s*\(\s*\)\s*;?\s*$/;
const FLUIDCAD_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]fluidcad(?:\/core)?['"]\s*;?/;

export class Client {
  panel: vscode.WebviewPanel | undefined = undefined;

  private serverProcess: ChildProcess | undefined;
  private serverUrl: string = '';
  private diagnosticCollection: vscode.DiagnosticCollection;
  private pendingExportUri: vscode.Uri | undefined;
  private syncingBreakpoints = false;

  currentSceneObjects: any[] = [];
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
      'fluidcad.export_file',
      () => this.exportFile()
    ));

    this.context.subscriptions.push(vscode.commands.registerCommand(
      'fluidcad.toggle_breakpoint',
      () => this.toggleBreakpoint()
    ));

    this.initLiveRender();
    this.initDebugBreakpointSync();

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

  private initDebugBreakpointSync() {
    this.context.subscriptions.push(
      vscode.debug.onDidChangeBreakpoints((event) => {
        if (this.syncingBreakpoints) {
          return;
        }
        for (const bp of event.added) {
          this.mirrorNativeBreakpoint(bp, true);
        }
        for (const bp of event.removed) {
          this.mirrorNativeBreakpoint(bp, false);
        }
      })
    );
  }

  private async mirrorNativeBreakpoint(bp: vscode.Breakpoint, added: boolean) {
    if (!(bp instanceof vscode.SourceBreakpoint)) {
      return;
    }
    const uri = bp.location.uri;
    if (!uri.fsPath.endsWith('.fluid.js')) {
      return;
    }
    const line = bp.location.range.start.line;
    const doc = await vscode.workspace.openTextDocument(uri);
    if (added) {
      await this.insertBreakpointText(doc, line, { addNative: false });
    } else {
      await this.removeBreakpointText(doc, line, { removeNative: false });
    }
  }

  private lineHasBreakpoint(doc: vscode.TextDocument, line: number): boolean {
    if (line < 0 || line >= doc.lineCount) {
      return false;
    }
    return BREAKPOINT_LINE.test(doc.lineAt(line).text);
  }

  private buildImportEdit(doc: vscode.TextDocument): { range: vscode.Range; text: string } | null {
    const source = doc.getText();
    const match = source.match(FLUIDCAD_IMPORT);

    if (match) {
      const names = match[1];
      if (/\bbreakpoint\b/.test(names)) {
        return null;
      }
      const braceOffset = match.index! + match[0].indexOf('{') + 1;
      const pos = doc.positionAt(braceOffset);
      const needsSpace = names.length > 0 && !/^\s/.test(names);
      return {
        range: new vscode.Range(pos, pos),
        text: needsSpace ? ' breakpoint,' : 'breakpoint,',
      };
    }

    const topPos = new vscode.Position(0, 0);
    return {
      range: new vscode.Range(topPos, topPos),
      text: `import { breakpoint } from 'fluidcad/core';\n`,
    };
  }

  private async insertBreakpointText(
    doc: vscode.TextDocument,
    line: number,
    opts: { addNative: boolean },
  ): Promise<void> {
    if (line < 0 || line > doc.lineCount) {
      return;
    }
    if (this.lineHasBreakpoint(doc, line)) {
      if (opts.addNative) {
        this.addNativeBreakpoint(doc.uri, line);
      }
      return;
    }

    const referenceLine = line > 0 ? line - 1 : 0;
    const refText = doc.lineAt(Math.min(referenceLine, doc.lineCount - 1)).text;
    const indentMatch = refText.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';

    const edit = new vscode.WorkspaceEdit();
    const importEdit = this.buildImportEdit(doc);
    if (importEdit) {
      edit.replace(doc.uri, importEdit.range, importEdit.text);
    }

    let insertPos: vscode.Position;
    let insertText: string;
    if (line >= doc.lineCount) {
      const lastLine = doc.lineAt(doc.lineCount - 1);
      insertPos = lastLine.range.end;
      insertText = `\n${indent}breakpoint();\n`;
    } else {
      const followingText = doc.lineAt(line).text;
      const needsBlank = followingText.trim() !== '';
      insertPos = new vscode.Position(line, 0);
      insertText = needsBlank
        ? `${indent}breakpoint();\n\n`
        : `${indent}breakpoint();\n`;
    }
    edit.insert(doc.uri, insertPos, insertText);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      return;
    }

    if (opts.addNative) {
      const nativeLine = importEdit && importEdit.text.includes('\n')
        ? line + 1
        : line;
      this.addNativeBreakpoint(doc.uri, nativeLine);
    }
  }

  private async removeBreakpointText(
    doc: vscode.TextDocument,
    line: number,
    opts: { removeNative: boolean },
  ): Promise<void> {
    if (!this.lineHasBreakpoint(doc, line)) {
      return;
    }
    const range = doc.lineAt(line).rangeIncludingLineBreak;
    const edit = new vscode.WorkspaceEdit();
    edit.delete(doc.uri, range);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      return;
    }

    if (opts.removeNative) {
      this.removeNativeBreakpoint(doc.uri, line);
    }
  }

  private addNativeBreakpoint(uri: vscode.Uri, line: number): void {
    const existing = vscode.debug.breakpoints.find(b =>
      b instanceof vscode.SourceBreakpoint &&
      b.location.uri.fsPath === uri.fsPath &&
      b.location.range.start.line === line
    );
    if (existing) {
      return;
    }
    const bp = new vscode.SourceBreakpoint(
      new vscode.Location(uri, new vscode.Position(line, 0)),
    );
    this.syncingBreakpoints = true;
    try {
      vscode.debug.addBreakpoints([bp]);
    } finally {
      this.syncingBreakpoints = false;
    }
  }

  private removeNativeBreakpoint(uri: vscode.Uri, line: number): void {
    const toRemove = vscode.debug.breakpoints.filter(b =>
      b instanceof vscode.SourceBreakpoint &&
      b.location.uri.fsPath === uri.fsPath &&
      b.location.range.start.line === line
    );
    if (toRemove.length === 0) {
      return;
    }
    this.syncingBreakpoints = true;
    try {
      vscode.debug.removeBreakpoints(toRemove);
    } finally {
      this.syncingBreakpoints = false;
    }
  }

  private async toggleBreakpoint() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.fileName.endsWith('.fluid.js')) {
      return;
    }

    const cursorLine = editor.selection.active.line;
    const doc = editor.document;

    if (this.lineHasBreakpoint(doc, cursorLine)) {
      await this.removeBreakpointText(doc, cursorLine, { removeNative: true });
      return;
    }
    const afterLine = cursorLine + 1;
    if (this.lineHasBreakpoint(doc, afterLine)) {
      await this.removeBreakpointText(doc, afterLine, { removeNative: true });
      return;
    }
    await this.insertBreakpointText(doc, afterLine, { addNative: true });
  }

  private async handleClearBreakpoints() {
    let editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.fileName.endsWith('.fluid.js')) {
      editor = vscode.window.visibleTextEditors.find(
        e => e.document.fileName === this.currentFileName
      );
    }
    if (!editor) {
      return;
    }

    const doc = editor.document;
    const linesToRemove: number[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      if (BREAKPOINT_LINE.test(doc.lineAt(i).text)) {
        linesToRemove.push(i);
      }
    }
    if (linesToRemove.length === 0) {
      return;
    }

    const applied = await editor.edit(b => {
      // Delete in reverse so earlier line ranges remain valid.
      for (let i = linesToRemove.length - 1; i >= 0; i--) {
        const range = doc.lineAt(linesToRemove[i]).rangeIncludingLineBreak;
        b.delete(range);
      }
    });

    if (!applied) {
      return;
    }

    for (const line of linesToRemove) {
      this.removeNativeBreakpoint(doc.uri, line);
    }

    this.updateLiveCode(doc.fileName, doc.getText());
  }

  private async handleAddBreakpointAfterLine(filePath: string, line: number) {
    let editor = vscode.window.visibleTextEditors.find(
      e => e.document.fileName === filePath
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

    // sourceLocation.line is 1-indexed and may point past the last actual
    // code line when the file has trailing newlines. Clamp and walk back
    // over blank lines to find the real source row.
    let sourceRow = Math.min(line - 1, doc.lineCount - 1);
    while (sourceRow >= 0 && doc.lineAt(sourceRow).text.trim() === '') {
      sourceRow--;
    }
    if (sourceRow < 0) {
      return;
    }

    const sourceText = doc.lineAt(sourceRow).text;
    const target = sourceRow + 1;
    if (this.lineHasBreakpoint(doc, target)) {
      return;
    }

    const indentMatch = sourceText.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';

    const importEdit = this.buildImportEdit(doc);
    const followingText = target < doc.lineCount ? doc.lineAt(target).text : '';
    const needsBlank = followingText.trim() !== '';

    const applied = await editor.edit(b => {
      if (importEdit) {
        b.replace(importEdit.range, importEdit.text);
      }
      if (target >= doc.lineCount) {
        const lastLine = doc.lineAt(doc.lineCount - 1);
        b.insert(lastLine.range.end, `\n${indent}breakpoint();\n`);
      } else {
        const insertText = needsBlank
          ? `${indent}breakpoint();\n\n`
          : `${indent}breakpoint();\n`;
        b.insert(new vscode.Position(target, 0), insertText);
      }
    });

    if (!applied) {
      return;
    }

    // Find where breakpoint() actually landed — authoritative rather than
    // guessing based on the import-edit shift.
    let finalLine = -1;
    for (let i = Math.max(0, target - 1); i < Math.min(doc.lineCount, target + 3); i++) {
      if (BREAKPOINT_LINE.test(doc.lineAt(i).text)) {
        finalLine = i;
        break;
      }
    }
    if (finalLine >= 0) {
      this.addNativeBreakpoint(doc.uri, finalLine);
    }

    this.updateLiveCode(doc.fileName, doc.getText());
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
      serverEntry = require.resolve('fluidcad/server', { paths: [workspacePath] });
    } catch {
      serverEntry = join(this.context.extensionUri.fsPath, '..', '..', 'server', 'src', 'index.ts');
    }

    const port = 3100 + Math.floor(Math.random() * 900);

    this.logger.appendLine(`Spawning server on port ${port}: ${serverEntry}`);

    const isTs = serverEntry.endsWith('.ts');
    const execArgv = isTs
      ? ['--experimental-transform-types', '--no-warnings', '--enable-source-maps']
      : ['--enable-source-maps'];

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

  private async handleServerMessage(msg: any) {
    switch (msg.type) {
      case 'scene-rendered': {
        this.currentSceneObjects = msg.result;
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
      case 'clear-breakpoints': {
        this.handleClearBreakpoints().catch((err) => {
          this.logger.appendLine(`[clear-breakpoints] error: ${err?.stack || err}`);
        });
        break;
      }
      case 'add-breakpoint': {
        const filePath = typeof msg.filePath === 'string' ? msg.filePath : this.currentFileName;
        if (filePath && typeof msg.line === 'number') {
          this.handleAddBreakpointAfterLine(filePath, msg.line).catch((err) => {
            this.logger.appendLine(`[add-breakpoint] error: ${err?.stack || err}`);
          });
        }
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
      case 'add-pick': {
        this.handleAddPick(msg);
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

  async exportFile() {
    const formatPick = await vscode.window.showQuickPick(
      ['STEP (.step)', 'STL (.stl)'],
      { placeHolder: 'Select export format' }
    );
    if (!formatPick) {
      return;
    }

    const isStl = formatPick.startsWith('STL');
    const format = isStl ? 'stl' : 'step';
    const options: Record<string, any> = { format };

    if (format === 'step') {
      options.includeColors = true;
    }

    if (isStl) {
      const resPick = await vscode.window.showQuickPick(
        ['Coarse', 'Medium', 'Fine', 'Custom'],
        { placeHolder: 'Select mesh resolution' }
      );
      if (!resPick) {
        return;
      }
      options.resolution = resPick.toLowerCase();

      if (options.resolution === 'custom') {
        const angStr = await vscode.window.showInputBox({
          prompt: 'Angular deviation in degrees',
          value: '17',
        });
        if (!angStr) {
          return;
        }
        options.customAngularDeflectionDeg = parseFloat(angStr);

        const linStr = await vscode.window.showInputBox({
          prompt: 'Linear deflection in mm',
          value: '0.3',
        });
        if (!linStr) {
          return;
        }
        options.customLinearDeflection = parseFloat(linStr);
      }
    }

    const ext = isStl ? 'stl' : 'step';
    const uri = await vscode.window.showSaveDialog({
      filters: isStl
        ? { 'STL Files': ['stl'] }
        : { 'STEP Files': ['step', 'stp'] },
      defaultUri: vscode.Uri.file(`export.${ext}`),
    });
    if (!uri) {
      return;
    }

    // Collect all solid shape IDs from the current scene
    const shapeIds: string[] = [];
    for (const obj of this.currentSceneObjects) {
      for (const shape of (obj.sceneShapes || [])) {
        if (shape.shapeType === 'solid' && !shape.isMetaShape) {
          shapeIds.push(shape.shapeId);
        }
      }
    }

    if (shapeIds.length === 0) {
      vscode.window.showErrorMessage('No solids in the scene to export.');
      return;
    }

    this.pendingExportUri = uri;
    this.sendToServer({
      type: 'export-scene',
      shapeIds,
      options,
    });
  }

  private async handleInsertPoint(msg: any) {
    const { point, sourceLocation } = msg;
    let line = sourceLocation.line - 1;
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

    if (line < 0) {
      return;
    }
    if (line >= editor.document.lineCount) {
      line = editor.document.lineCount - 1;
    }
    while (line >= 0 && editor.document.lineAt(line).text.trim() === '') {
      line--;
    }
    if (line < 0) {
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

  private async handleAddPick(msg: any) {
    const { sourceLocation } = msg;
    let line = sourceLocation.line - 1;

    this.logger.appendLine(`[add-pick] sourceLocation: line=${sourceLocation.line}, filePath=${sourceLocation.filePath}`);
    this.logger.appendLine(`[add-pick] currentFileName: ${this.currentFileName}`);

    let editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.fileName !== this.currentFileName) {
      editor = vscode.window.visibleTextEditors.find(
        e => e.document.fileName === this.currentFileName
      );
    }
    if (!editor) {
      this.logger.appendLine(`[add-pick] No editor found for ${this.currentFileName}`);
      return;
    }

    if (line < 0) {
      return;
    }
    // sourceLocation.line may point past the last editor line (trailing newline
    // mismatch between live-update code and editor). Search backwards for the
    // actual code line containing the feature call.
    if (line >= editor.document.lineCount) {
      line = editor.document.lineCount - 1;
    }
    while (line >= 0 && editor.document.lineAt(line).text.trim() === '') {
      line--;
    }
    if (line < 0) {
      return;
    }

    const lineText = editor.document.lineAt(line).text;

    // If .pick( already exists on this line, do nothing
    if (lineText.includes('.pick(')) {
      return;
    }

    // Find the last ')' on the line and append .pick() after it
    const lastCloseParen = lineText.lastIndexOf(')');
    if (lastCloseParen < 0) {
      return;
    }

    const pos = new vscode.Position(line, lastCloseParen + 1);
    const applied = await editor.edit(b => b.insert(pos, '.pick()'));
    this.logger.appendLine(`[add-pick] Edit applied: ${applied}`);
    if (applied) {
      this.updateLiveCode(editor.document.fileName, editor.document.getText());
    }
  }

  private async handleRemovePoint(msg: any) {
    const { point, sourceLocation } = msg;
    let line = sourceLocation.line - 1;

    let editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.fileName !== this.currentFileName) {
      editor = vscode.window.visibleTextEditors.find(
        e => e.document.fileName === this.currentFileName
      );
    }
    if (!editor) {
      return;
    }

    if (line < 0) {
      return;
    }
    if (line >= editor.document.lineCount) {
      line = editor.document.lineCount - 1;
    }
    while (line >= 0 && editor.document.lineAt(line).text.trim() === '') {
      line--;
    }
    if (line < 0) {
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
    let line = sourceLocation.line - 1;

    let editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.fileName !== this.currentFileName) {
      editor = vscode.window.visibleTextEditors.find(
        e => e.document.fileName === this.currentFileName
      );
    }
    if (!editor) {
      return;
    }

    if (line < 0) {
      return;
    }
    if (line >= editor.document.lineCount) {
      line = editor.document.lineCount - 1;
    }
    while (line >= 0 && editor.document.lineAt(line).text.trim() === '') {
      line--;
    }
    if (line < 0) {
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

import * as vscode from 'vscode';
import { join } from 'path';
import { fork } from 'child_process';
import type { Client } from './client';
import { createWebviewPanel } from './webview';

export function sendToServer(client: Client, msg: any) {
  if (client.serverProcess?.connected) {
    client.serverProcess.send(msg);
  } else {
    client.logger.appendLine('Server process not connected, cannot send message');
  }
}

export function processFile(client: Client, filePath: string) {
  client.currentFileName = filePath;
  sendToServer(client, {
    type: 'process-file',
    filePath,
  });
}

export function updateLiveCode(client: Client, fileName: string, newCode: string) {
  if (client.debounceTimer) {
    clearTimeout(client.debounceTimer);
    client.debounceTimer = undefined;
  }
  sendToServer(client, {
    type: 'live-update',
    fileName,
    code: newCode,
  });
}

export function initLiveRender(client: Client) {
  const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
    const doc = event.document;
    if (!doc.fileName.endsWith('.fluid.js')) {
      return;
    }

    if (client.debounceTimer) {
      clearTimeout(client.debounceTimer);
    }

    client.debounceTimer = setTimeout(() => {
      updateLiveCode(client, doc.fileName, doc.getText());
      client.debounceTimer = undefined;
    }, 300);
  });

  client.context.subscriptions.push(disposable);
}

/**
 * Snapshot the editor's dirty-buffer set and ship it to the server over IPC.
 * The server caches the set behind `GET /api/editor/dirty-files`, which the
 * MCP source-editing tools probe before clobbering a file. Only `.fluid.js`
 * buffers are tracked — the agent has no reason to write anything else.
 */
function snapshotDirtyFiles(): string[] {
  const dirty = new Set<string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty) { continue; }
    if (doc.uri.scheme !== 'file') { continue; }
    if (!doc.fileName.endsWith('.fluid.js')) { continue; }
    dirty.add(doc.uri.fsPath);
  }
  return Array.from(dirty);
}

export function initDirtyState(client: Client) {
  // The dirty-files set only changes when a buffer's `isDirty` flips. Short-
  // circuit on a stable signature so the per-keystroke onDidChangeTextDocument
  // firings don't translate to per-keystroke IPC writes.
  let lastSignature: string | null = null;
  const send = () => {
    const files = snapshotDirtyFiles().sort();
    const signature = files.join('\0');
    if (signature === lastSignature) {
      return;
    }
    lastSignature = signature;
    sendToServer(client, {
      type: 'editor-dirty-state',
      dirtyFiles: files,
    });
  };

  // Replay the current state once at startup. The server's set starts empty,
  // so without this any buffer that was already dirty before activation
  // would slip past the MCP guard.
  send();

  client.context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(() => send()),
    vscode.workspace.onDidSaveTextDocument(() => send()),
    vscode.workspace.onDidCloseTextDocument(() => send()),
    vscode.workspace.onDidOpenTextDocument(() => send()),
  );
}


export async function spawnServer(client: Client, workspacePath: string): Promise<void> {
  let serverEntry: string;
  try {
    serverEntry = require.resolve('fluidcad/server', { paths: [workspacePath] });
  } catch {
    serverEntry = join(client.context.extensionUri.fsPath, '..', '..', 'server', 'src', 'index.ts');
  }

  const port = 3100 + Math.floor(Math.random() * 900);

  client.logger.appendLine(`Spawning server on port ${port}: ${serverEntry}`);

  const isTs = serverEntry.endsWith('.ts');
  const execArgv = isTs
    ? ['--experimental-transform-types', '--no-warnings', '--enable-source-maps']
    : ['--enable-source-maps'];

  client.serverProcess = fork(serverEntry, [], {
    env: {
      ...process.env,
      FLUIDCAD_SERVER_PORT: String(port),
      FLUIDCAD_WORKSPACE_PATH: workspacePath,
    },
    execArgv,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  client.serverProcess.stdout?.on('data', (data) => {
    client.logger.appendLine(`[server] ${data.toString().trim()}`);
  });

  client.serverProcess.stderr?.on('data', (data) => {
    client.logger.appendLine(`[server:err] ${data.toString().trim()}`);
  });

  client.serverProcess.on('message', (msg: any) => {
    client.handleServerMessage(msg);
  });

  // Persistent exit handler — fires on any server crash/restart, not just
  // during initial startup. Clears stale diagnostics so the editor doesn't
  // show outdated squigglies after the server dies.
  client.serverProcess.on('exit', () => {
    client.diagnosticCollection.clear();
    client.currentSceneObjects = [];
    client.currentCompileError = null;
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 30000);

    const onMessage = (msg: any) => {
      if (msg.type === 'ready') {
        client.serverUrl = msg.url;
        client.logger.appendLine(`Server ready at ${client.serverUrl}`);
        createWebviewPanel(client);
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

    client.serverProcess!.on('message', onMessage);

    client.serverProcess!.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    client.serverProcess!.on('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });
}

export async function importFile(client: Client) {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'STEP Files': ['step', 'stp'] },
    title: 'Import STEP File',
  });

  if (!uris || uris.length === 0) {
    return;
  }

  const uri = uris[0];
  const data = await vscode.workspace.fs.readFile(uri);
  const fileName = uri.fsPath.split('/').pop() || uri.fsPath;
  const workspacePath = client.getActiveWorkspaceFolder();

  client.logger.appendLine(`Importing file: ${fileName}`);

  sendToServer(client, {
    type: 'import-file',
    workspacePath,
    fileName,
    data: Buffer.from(data).toString('base64'),
  });
}

export async function exportFile(client: Client) {
  const formatPick = await vscode.window.showQuickPick(
    ['STEP (.step)', 'STL (.stl)'],
    { placeHolder: 'Select export format' },
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
      { placeHolder: 'Select mesh resolution' },
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

  const shapeIds: string[] = [];
  for (const obj of client.currentSceneObjects) {
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

  client.pendingExportUri = uri;
  sendToServer(client, {
    type: 'export-scene',
    shapeIds,
    options,
  });
}

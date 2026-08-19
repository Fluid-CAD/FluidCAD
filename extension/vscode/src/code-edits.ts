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

/**
 * Resolve the editor showing `filePath`, opening the document when it is not
 * already visible. Used by the edits that target a file the server names
 * rather than whatever the user happens to be looking at.
 */
async function resolveEditorForPath(filePath: string): Promise<vscode.TextEditor> {
  const visible = vscode.window.visibleTextEditors.find(
    e => e.document.fileName === filePath,
  );
  if (visible) {
    return visible;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  return vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preserveFocus: true,
    preview: false,
  });
}

/**
 * Server-driven editor history: run VSCode's native undo/redo on the document
 * backing `filePath` and ack the outcome over IPC. The built-in undo/redo
 * commands act on the *active* editor, so unlike every other handler this one
 * takes focus before running the command.
 */
export async function handleUndoRedo(
  client: Client,
  msg: { type: 'undo' | 'redo'; filePath: string; editId: string },
) {
  let error: string | undefined;
  try {
    const editor = await resolveEditorForPath(msg.filePath);
    const doc = editor.document;
    await vscode.window.showTextDocument(doc, {
      viewColumn: editor.viewColumn ?? vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false,
    });
    const versionBefore = doc.version;
    await vscode.commands.executeCommand(msg.type);
    if (doc.version === versionBefore) {
      error = msg.type === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.';
    } else {
      // Skip the live-render debounce so the viewport answers the click.
      client.updateLiveCode(doc.fileName, doc.getText());
    }
  } catch (err: any) {
    error = err?.message || String(err);
  }
  client.sendToServer({ type: 'edit-ack', editId: msg.editId, error });
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

export async function handleAddGuide(client: Client, msg: { sourceLocation: { line: number } }) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    client.logger.appendLine(`[add-guide] No editor found for ${client.currentFileName}`);
    return;
  }
  const doc = editor.document;
  const result = await codeApi.addGuide(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleRemoveGuide(client: Client, msg: { sourceLocation: { line: number } }) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    client.logger.appendLine(`[remove-guide] No editor found for ${client.currentFileName}`);
    return;
  }
  const doc = editor.document;
  const result = await codeApi.removeGuide(
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

export async function handleSetTrimTargets(client: Client, msg: { args: string; sourceLocation: { line: number } }) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    client.logger.appendLine(`[set-trim-targets] No editor found for ${client.currentFileName}`);
    return;
  }
  const doc = editor.document;
  const result = await codeApi.setTrimTargets(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.args, client.logger,
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

export async function handleRemoveFeature(client: Client, msg: { filePath: string; line: number }) {
  // The feature may live in a file other than the active one (imported
  // models), so resolve the document by path like the breakpoint handler.
  const editor = await resolveEditorForPath(msg.filePath || client.currentFileName);
  const doc = editor.document;
  const result = await codeApi.removeStatement(
    client.serverUrl, doc.getText(), msg.line, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleRenameFeature(
  client: Client,
  msg: { filePath: string; line: number; name: string | null },
) {
  // Like Remove, the feature may live in a file other than the active one.
  const editor = await resolveEditorForPath(msg.filePath || client.currentFileName);
  const doc = editor.document;
  const result = await codeApi.setFeatureName(
    client.serverUrl, doc.getText(), msg.line, msg.name, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleInsertLoad(client: Client, msg: { filePath: string; fileName: string }) {
  const editor = await resolveEditorForPath(msg.filePath || client.currentFileName);
  const doc = editor.document;
  const result = await codeApi.insertLoad(
    client.serverUrl, doc.getText(), msg.fileName, client.logger,
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

export async function handleUpdateInsertChain(
  client: Client,
  msg: {
    sourceLocation: { filePath: string; line: number };
    edit: codeApi.InsertChainEdit;
  },
) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.updateInsertChain(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.edit, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
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

export async function handleInsertGeometry(
  client: Client,
  msg: {
    statement: string;
    sketchSourceLocation: { line: number };
    newVariable?: { name: string; initializer: string } | null;
  },
) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.insertGeometry(
    client.serverUrl, doc.getText(), msg.sketchSourceLocation.line, msg.statement, client.logger,
    msg.newVariable ?? null,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleApplyFeatureEdit(client: Client, msg: { spec: unknown }) {
  // The spec names its target file — cross-file edits (the assembly mate
  // dialog editing/creating a connector() in a PART file) must apply there,
  // not to whatever the user is looking at.
  const specPath = (msg.spec as { filePath?: unknown } | null)?.filePath;
  const targetPath = typeof specPath === 'string' && specPath.length > 0
    ? specPath
    : client.currentFileName;
  let editor: vscode.TextEditor | undefined;
  if (targetPath === client.currentFileName) {
    editor = findEditorForCurrentFile(client);
  } else {
    try {
      editor = await resolveEditorForPath(targetPath);
    } catch {
      editor = undefined;
    }
  }
  if (!editor) {
    client.logger.appendLine(`[apply-feature] No editor found for ${targetPath}`);
    return;
  }
  const doc = editor.document;
  const result = await codeApi.applyFeature(client.serverUrl, doc.getText(), msg.spec, client.logger);
  if (!result) {
    return;
  }
  if (result.error) {
    client.logger.appendLine(`[apply-feature] ${result.error}`);
    vscode.window.showErrorMessage(`FluidCAD: ${result.error}`);
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText(), doc.fileName !== client.currentFileName);
  }
}

export async function handleUpdateDimension(
  client: Client,
  msg: { newValue: number; sourceLocation: { line: number } },
) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.updateDimension(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.newValue, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleUpdateDimensionExpression(
  client: Client,
  msg: {
    expression: string;
    sourceLocation: { line: number };
    sketchSourceLine?: number | null;
    newVariable?: { name: string; initializer: string } | null;
    dimensionOffset?: number;
    dimensionCall?: string | null;
    dimensionInsert?: boolean;
    dimensionPoint?: [number, number] | null;
  },
) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.updateDimensionExpression(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.expression, client.logger,
    msg.sketchSourceLine ?? null,
    msg.newVariable ?? null,
    msg.dimensionOffset ?? 0,
    msg.dimensionCall ?? null,
    msg.dimensionInsert === true,
    msg.dimensionPoint ?? null,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleUpdatePointExpression(
  client: Client,
  msg: {
    xExpr: string;
    yExpr: string;
    sourceLocation: { line: number };
    sketchSourceLine?: number | null;
    newVariable?: { name: string; initializer: string }[] | null;
    pointIndex?: number;
    oldPosition?: [number, number] | null;
  },
) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.updatePointExpression(
    client.serverUrl, doc.getText(), msg.sourceLocation.line,
    msg.xExpr, msg.yExpr, client.logger,
    msg.sketchSourceLine ?? null,
    msg.newVariable ?? null,
    msg.pointIndex ?? 0,
    msg.oldPosition ?? null,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleUpdatePosition(
  client: Client,
  msg: {
    newPosition: [number, number];
    sourceLocation: { line: number };
    pointIndex?: number;
    oldPosition?: [number, number] | null;
  },
) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.updatePosition(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.newPosition, client.logger,
    msg.pointIndex ?? 0,
    msg.oldPosition ?? null,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleSetLinePosition(
  client: Client,
  msg: { newStart: [number, number]; newEnd: [number, number]; sourceLocation: { line: number } },
) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.setLinePosition(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.newStart, msg.newEnd, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

export async function handleSetChainPositions(
  client: Client,
  msg: { updates: { pointIndex: number; position: [number, number] }[]; sourceLocation: { line: number } },
) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.setChainPositions(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.updates, client.logger,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

/**
 * Solved-sketch batch position write-back (sketch-rewrite P4). One
 * `replaceDocument` = one undo step for every drifted statement of the drag;
 * the transform's outcome (including drift refusals) rides back to the
 * waiting HTTP request via the IPC edit-ack.
 */
export async function handleUpdateSketchPositions(
  client: Client,
  msg: {
    editId?: string;
    filePath?: string;
    edits: codeApi.SketchPositionEditPayload[];
  },
) {
  const ack = (error?: string) => {
    if (msg.editId) {
      client.sendToServer({ type: 'edit-ack', editId: msg.editId, error });
    }
  };
  try {
    const editor = msg.filePath
      ? await resolveEditorForPath(msg.filePath)
      : findEditorForCurrentFile(client);
    if (!editor) {
      ack("no editor is showing the sketch's file");
      return;
    }
    const doc = editor.document;
    const result = await codeApi.updateSketchPositions(
      client.serverUrl, doc.getText(), msg.edits, client.logger,
    );
    if (!result) {
      ack('the code transform request failed — check the FluidCAD output channel');
      return;
    }
    if (result.error) {
      ack(result.error);
      return;
    }
    if (await codeApi.replaceDocument(doc, result.newCode)) {
      client.updateLiveCode(doc.fileName, doc.getText());
      ack(undefined);
    } else {
      ack('the editor rejected the buffer edit');
    }
  } catch (err: any) {
    ack(err?.message || String(err));
  }
}

export async function handleSetRectDimensions(
  client: Client,
  msg: {
    startPoint: [number, number] | null;
    width: number;
    height: number;
    sourceLocation: { line: number };
    oldStartPoint?: [number, number] | null;
  },
) {
  const editor = findEditorForCurrentFile(client);
  if (!editor) {
    return;
  }
  const doc = editor.document;
  const result = await codeApi.setRectDimensions(
    client.serverUrl, doc.getText(), msg.sourceLocation.line, msg.startPoint, msg.width, msg.height, client.logger,
    msg.oldStartPoint ?? null,
  );
  if (!result) {
    return;
  }
  if (await codeApi.replaceDocument(doc, result.newCode)) {
    client.updateLiveCode(doc.fileName, doc.getText());
  }
}

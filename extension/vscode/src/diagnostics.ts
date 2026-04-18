import * as vscode from 'vscode';
import type { Client } from './client';

export function updateDiagnostics(client: Client) {
  client.diagnosticCollection.clear();

  const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();

  for (const obj of client.currentSceneObjects) {
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
    client.diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
  }
}

export async function revealSourceLocation(loc: { filePath: string; line: number; column: number }) {
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

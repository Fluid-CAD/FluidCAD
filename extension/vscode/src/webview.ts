import * as vscode from 'vscode';
import type { Client } from './client';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function getHTML(serverUrl: string): string {
  const nonce = getNonce();
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
				<iframe src="${serverUrl}"></iframe>
			</body>
			</html>
  `;
}

export function createWebviewPanel(client: Client) {
  client.panel = vscode.window.createWebviewPanel(
    'fluidcadEditor.fluidjs',
    'FluidCAD Editor',
    vscode.ViewColumn.Two,
    {
      retainContextWhenHidden: false,
      enableScripts: true,
    },
  );

  client.panel.onDidDispose(() => {
    client.panel = undefined;
  });

  client.panel.webview.html = getHTML(client.serverUrl);
}

export function revealPanel(client: Client) {
  if (client.panel) {
    client.panel.reveal(vscode.ViewColumn.Two, true);
  }
}

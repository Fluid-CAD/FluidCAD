import * as vscode from 'vscode';
import { readFileSync } from 'fs';
import { join } from 'path';

function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA > numB) {
      return 1;
    }
    if (numA < numB) {
      return -1;
    }
  }
  return 0;
}

function getInstalledPackageVersion(workspacePath: string): string | null {
  const pkgPath = join(workspacePath, 'node_modules', 'fluidcad', 'package.json');
  try {
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    return pkg.version || null;
  } catch {
    return null;
  }
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
  return context.extension.packageJSON.version;
}

function runNpmInstall(workspacePath: string, version: string): void {
  const terminal = vscode.window.createTerminal({
    name: 'FluidCAD Update',
    cwd: workspacePath,
  });
  terminal.show();
  terminal.sendText(`npm install fluidcad@${version}`);

  vscode.window.showInformationMessage(
    'After the install completes, reload the window to use the updated package.',
    'Reload Window'
  ).then((choice) => {
    if (choice === 'Reload Window') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
}

export async function checkVersionMismatch(context: vscode.ExtensionContext, logger: vscode.OutputChannel): Promise<void> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const npmVersion = getInstalledPackageVersion(workspacePath);
    if (!npmVersion) {
      logger.appendLine('FluidCAD npm package not found in workspace, skipping version check');
      return;
    }

    const extVersion = getExtensionVersion(context);
    const cmp = compareSemver(extVersion, npmVersion);

    logger.appendLine(`Version check: extension v${extVersion}, npm package v${npmVersion}`);

    if (cmp === 0) {
      logger.appendLine('Versions match');
      return;
    }

    if (cmp > 0) {
      // Extension is newer than npm package
      const autoUpdate = vscode.workspace.getConfiguration('fluidcad').get<boolean>('autoUpdatePackage');

      if (autoUpdate) {
        logger.appendLine(`Auto-updating npm package from v${npmVersion} to v${extVersion}`);
        runNpmInstall(workspacePath, extVersion);
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `Your FluidCAD npm package (v${npmVersion}) is outdated. Update to v${extVersion}?`,
        'Update',
        'Always Update',
        'Dismiss'
      );

      if (choice === 'Update') {
        runNpmInstall(workspacePath, extVersion);
      } else if (choice === 'Always Update') {
        await vscode.workspace.getConfiguration('fluidcad').update('autoUpdatePackage', true, vscode.ConfigurationTarget.Global);
        runNpmInstall(workspacePath, extVersion);
      }
    } else {
      // npm package is newer than extension
      const choice = await vscode.window.showWarningMessage(
        `Your FluidCAD extension (v${extVersion}) is outdated. The installed npm package is v${npmVersion}. Please update the extension.`,
        'Open Extension'
      );

      if (choice === 'Open Extension') {
        vscode.commands.executeCommand('extension.open', 'FluidCAD.fluidcad');
      }
    }
  } catch (err) {
    logger.appendLine(`Version check failed: ${err}`);
  }
}

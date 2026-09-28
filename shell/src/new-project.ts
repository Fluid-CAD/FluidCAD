import { BrowserWindow, dialog } from 'electron';
import path from 'path';
import { inspectFolder } from '../../launcher/src/projects/scaffold';

/**
 * "New project" from the start screen or the File menu: the user picks an
 * empty folder in the native dialog, and the window that opens the project
 * sets it up there first (`fluidcad init`, through the launcher's
 * `scaffoldProject`), with its progress on the opening overlay. This is only
 * the asking; `npx fluidcad`, which has no native dialog, asks in its page.
 */

export type NewProjectChoice =
  /** An empty folder: set a project up in it, then open it. */
  | { path: string; create: true }
  /** The folder already holds a project and the user chose to open it. */
  | { path: string; create: false };

export async function chooseNewProjectFolder(parent: BrowserWindow | null): Promise<NewProjectChoice | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'New FluidCAD project',
    message: 'Choose an empty folder. FluidCAD will set the project up inside it.',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Create project',
  };
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || !picked.filePaths[0]) {
    return null;
  }
  const folder = path.resolve(picked.filePaths[0]);

  switch (inspectFolder(folder)) {
    case 'empty':
      return { path: folder, create: true };
    case 'project': {
      // Not empty, but a project — the likely intent is to open it.
      const answer = await messageBox(parent, {
        type: 'question',
        message: 'This folder already holds a FluidCAD project.',
        detail: `${folder}\n\nOpen it instead?`,
        buttons: ['Open project', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      return answer.response === 0 ? { path: folder, create: false } : null;
    }
    case 'not-empty':
      await report(
        parent,
        'This folder is not empty.',
        `${folder}\n\nA new project needs an empty folder — pick another one, or create one from the dialog.`,
      );
      return null;
    default:
      await report(parent, 'This folder could not be read.', folder);
      return null;
  }
}

function messageBox(
  parent: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

function report(parent: BrowserWindow | null, message: string, detail: string): Promise<unknown> {
  return messageBox(parent, { type: 'error', message, detail });
}

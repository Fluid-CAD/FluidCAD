import { app, Menu, MenuItemConstructorOptions, shell } from 'electron';
import { listRecentProjects } from '../../launcher/src/projects/app-state';
import type { OpenPhase } from '../../launcher/src/projects/open-state';
import { pendingUpdateVersion, restartToUpdate } from './updater';
import { AppWindow } from './window/app-window';

/**
 * The application menu.
 *
 * Two kinds of item live here. Shell actions (open a project, a new window,
 * quit) the main process performs itself. Everything that touches a model is
 * sent to the project's page as a command and the page decides what it means
 * — the same rule as everywhere else in this shell: the engine owns the
 * product. Those items are enabled only while the focused window shows a
 * project; on the start screen there is no page to act on them.
 *
 * It also fixes the keybindings a browser tab was stealing. In `npx fluidcad
 * serve`, Ctrl/Cmd+W closes the tab, Ctrl+S offers to save the HTML, and
 * Ctrl+N opens a window. Here they mean close the project, save the file, and
 * new file. Close Project returns the window to the start screen; on the start
 * screen it closes the window — the same split as a code editor's close-editor
 * and close-window.
 *
 * The menu is a snapshot: it is rebuilt when the focused window changes, when
 * a window's state changes, when the recents change and when an update is
 * staged.
 */

export type MenuActions = {
  /** Open a project (null asks for one), in the focused window or a new one. */
  openProject: (target: string | null) => Promise<unknown>;
  /** Scaffold a project with `fluidcad init` in a folder the user picks, then open it. */
  newProject: () => Promise<unknown>;
  newWindow: () => void;
};

export type MenuEnablement = {
  /** Save, New File, Import, Export, Undo/Redo, Find File, Toggle Editor, Restart Engine. */
  projectCommands: boolean;
  /** Close Project and Close Window need a window to act on. */
  windowCommands: boolean;
};

/** What the focused window's phase allows; null when no window is focused. */
export function menuEnablement(phase: OpenPhase | null): MenuEnablement {
  return { projectCommands: phase === 'project', windowCommands: phase !== null };
}

/** Send a command to the focused window's project page. */
function toProject(command: string, payload?: unknown): void {
  AppWindow.focused()?.sendMenuCommand(command, payload);
}

/**
 * Present only while an update sits downloaded and waiting. The updater installs
 * it on the next quit regardless; this is the shortcut for the impatient.
 */
function updateItems(): MenuItemConstructorOptions[] {
  const version = pendingUpdateVersion();
  if (!version) {
    return [];
  }
  return [
    { label: `Restart to Update to FluidCAD ${version}`, click: () => restartToUpdate() },
    { type: 'separator' },
  ];
}

function recentProjectsSubmenu(actions: MenuActions): MenuItemConstructorOptions[] {
  const recents = listRecentProjects();
  if (recents.length === 0) {
    return [{ label: 'No recent projects', enabled: false }];
  }
  return recents.map((entry) => ({
    label: entry.pin ? `${entry.path}  (engine ${entry.pin})` : entry.path,
    click: () => void actions.openProject(entry.path),
  }));
}

export function buildApplicationMenu(actions: MenuActions): void {
  const isMac = process.platform === 'darwin';
  const focused = AppWindow.focused();
  const enabled = menuEnablement(focused?.phase ?? null);
  const project = enabled.projectCommands;

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              ...updateItems(),
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New File', accelerator: 'CmdOrCtrl+N', enabled: project, click: () => toProject('new-file') },
        { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: () => void actions.newProject() },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => void actions.openProject(null) },
        { label: 'Open Recent', submenu: recentProjectsSubmenu(actions) },
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+O', click: () => actions.newWindow() },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', enabled: project, click: () => toProject('save') },
        { label: 'Save All', accelerator: 'CmdOrCtrl+Alt+S', enabled: project, click: () => toProject('save-all') },
        { type: 'separator' },
        { label: 'Import STEP…', enabled: project, click: () => toProject('import') },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', enabled: project, click: () => toProject('export') },
        { type: 'separator' },
        // Close the *project*, not a browser tab — the collision this fixes.
        {
          label: 'Close Project',
          accelerator: 'CmdOrCtrl+W',
          enabled: enabled.windowCommands,
          click: () => AppWindow.focused()?.closeProjectCommand(),
        },
        {
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+Shift+W',
          enabled: enabled.windowCommands,
          click: () => AppWindow.focused()?.browserWindow.close(),
        },
        ...(isMac ? [] : ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Routed to the page so they land on Monaco's own undo stack — the same
        // path the toolbar buttons use (`editor-hello { undoRedo: true }`).
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', enabled: project, click: () => toProject('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', enabled: project, click: () => toProject('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find File…', accelerator: 'CmdOrCtrl+P', enabled: project, click: () => toProject('quick-open') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Editor', accelerator: 'CmdOrCtrl+B', enabled: project, click: () => toProject('toggle-editor') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Engine',
      submenu: [
        {
          label: 'Restart Engine',
          enabled: project,
          click: () => void AppWindow.focused()?.restartEngine(),
        },
      ],
    },
    {
      label: 'Window',
      // Close lives in File, as Close Project and Close Window, each with its
      // own accelerator; a second Close here would claim Ctrl/Cmd+W again.
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }],
    },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : updateItems()),
        { label: 'Documentation', click: () => void shell.openExternal('https://fluidcad.io/docs/introduction/') },
        {
          label: 'Report an Issue',
          click: () => void shell.openExternal('https://github.com/Fluid-CAD/FluidCAD/issues'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The menu is a snapshot; rebuild it when anything it shows may have changed. */
export function refreshApplicationMenu(actions: MenuActions): void {
  buildApplicationMenu(actions);
}

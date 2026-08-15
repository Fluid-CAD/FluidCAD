import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron';
import { listRecentProjects } from './state';
import { windowFor } from './project-window';

/**
 * The application menu.
 *
 * Two kinds of item live here. Shell actions (open a project, manage engines,
 * quit) the main process performs itself. Everything that touches a model is
 * sent to the page as a command and the page decides what it means — which is
 * the same rule as everywhere else in this shell: the engine owns the product.
 *
 * It also fixes the keybindings a browser tab was stealing. In `npx fluidcad
 * serve`, Ctrl/Cmd+W closes the tab, Ctrl+S offers to save the HTML, and
 * Ctrl+N opens a window. Here they mean close the project, save the file, and
 * new file.
 */

export type MenuActions = {
  openProject: (target: string | null) => Promise<void>;
  openEngineManager: () => Promise<void>;
};

/** Send a command to the focused project window's page. */
function toPage(command: string, payload?: unknown): void {
  const window = windowFor(BrowserWindow.getFocusedWindow());
  window?.sendMenuCommand(command, payload);
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

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Engines…', click: () => void actions.openEngineManager() },
              { type: 'separator' },
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
        {
          label: 'New File',
          accelerator: 'CmdOrCtrl+N',
          click: () => toPage('new-file'),
        },
        {
          label: 'Open Project…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void actions.openProject(null),
        },
        { label: 'Open Recent', submenu: recentProjectsSubmenu(actions) },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => toPage('save') },
        { label: 'Save All', accelerator: 'CmdOrCtrl+Alt+S', click: () => toPage('save-all') },
        { type: 'separator' },
        { label: 'Import STEP…', click: () => toPage('import') },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: () => toPage('export') },
        { type: 'separator' },
        // Close the *project*, not a browser tab — the collision this fixes.
        isMac ? { role: 'close', label: 'Close Project' } : { role: 'quit', label: 'Close Project' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Routed to the page so they land on Monaco's own undo stack — the same
        // path the toolbar buttons use (`editor-hello { undoRedo: true }`).
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => toPage('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => toPage('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find File…', accelerator: 'CmdOrCtrl+P', click: () => toPage('quick-open') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Editor', accelerator: 'CmdOrCtrl+B', click: () => toPage('toggle-editor') },
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
        { label: 'Manage Engines…', click: () => void actions.openEngineManager() },
        {
          label: 'Restart Engine',
          click: () => void windowFor(BrowserWindow.getFocusedWindow())?.restartEngine(),
        },
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Documentation', click: () => void shell.openExternal('https://fluidcad.io/docs') },
        {
          label: 'Report an Issue',
          click: () => void shell.openExternal('https://github.com/Fluid-CAD/FluidCAD/issues'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The recents submenu is built once per menu; rebuild after opening a project. */
export function refreshApplicationMenu(actions: MenuActions): void {
  buildApplicationMenu(actions);
}

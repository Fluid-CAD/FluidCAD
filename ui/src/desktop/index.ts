/**
 * The desktop shell bridge, from the page's side.
 *
 * The same `ui/dist` runs in three places: a browser tab from `npx fluidcad
 * serve`, a VS Code webview, and the Electron shell. Only the last one exposes
 * `window.fluidcadDesktop`, so every function here degrades to the browser
 * behaviour when it isn't there — that is the contract, not a fallback.
 *
 * What the shell adds is native gestures the page cannot perform for itself:
 * a real Save dialog (instead of a silent download into ~/Downloads), a file
 * picker outside the workspace, and the application menu.
 */

export type DesktopFileFilter = { name: string; extensions: string[] };

type DesktopApi = {
  isDesktop: true;
  platform: string;
  showOpenDialog(request: {
    title?: string;
    defaultPath?: string;
    filters?: DesktopFileFilter[];
    properties?: string[];
  }): Promise<string[] | null>;
  showSaveDialog(request: {
    title?: string;
    defaultPath?: string;
    filters?: DesktopFileFilter[];
  }): Promise<string | null>;
  writeFile(filePath: string, base64: string): Promise<{ ok: boolean; error?: string }>;
  readFile(filePath: string): Promise<{ ok: boolean; base64?: string; error?: string }>;
  showItemInFolder(filePath: string): void;
  setTitle(title: string): void;
  onMenuCommand(handler: (command: string, payload?: unknown) => void): void;
  restartEngine(): Promise<void>;
};

declare global {
  interface Window {
    fluidcadDesktop?: DesktopApi;
  }
}

export function desktop(): DesktopApi | null {
  return typeof window !== 'undefined' && window.fluidcadDesktop?.isDesktop
    ? window.fluidcadDesktop
    : null;
}

export function isDesktop(): boolean {
  return desktop() !== null;
}

async function toBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000; // Chunked: String.fromCharCode(...huge) blows the stack.
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export type DeliveryResult = 'saved' | 'cancelled' | 'downloaded' | 'failed';

/**
 * Hand a produced file to the user: a native Save dialog on the desktop, an
 * ordinary browser download everywhere else.
 */
export async function deliverFile(
  blob: Blob,
  defaultName: string,
  filters: DesktopFileFilter[] = [],
): Promise<DeliveryResult> {
  const api = desktop();
  if (!api) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = defaultName;
    anchor.click();
    URL.revokeObjectURL(url);
    return 'downloaded';
  }

  const filePath = await api.showSaveDialog({ defaultPath: defaultName, filters });
  if (!filePath) {
    return 'cancelled';
  }
  const result = await api.writeFile(filePath, await toBase64(blob));
  if (!result.ok) {
    return 'failed';
  }
  // Land the user where the file went; it is the whole reason they picked a path.
  api.showItemInFolder(filePath);
  return 'saved';
}

/** Every command the application menu can send. */
export type DesktopMenuHandlers = {
  save?: () => void;
  'save-all'?: () => void;
  'new-file'?: () => void;
  'quick-open'?: () => void;
  'toggle-editor'?: () => void;
  undo?: () => void;
  redo?: () => void;
  import?: () => void;
  export?: () => void;
};

/**
 * Route the shell's menu commands into the page. The shell deliberately
 * decides nothing here: it names an intent, and the page — which owns the
 * editor, the dialogs and the scene — decides what it means.
 */
export function installDesktopMenu(handlers: DesktopMenuHandlers): void {
  const api = desktop();
  if (!api) {
    return;
  }
  api.onMenuCommand((command) => {
    const handler = handlers[command as keyof DesktopMenuHandlers];
    if (handler) {
      handler();
    }
  });
}

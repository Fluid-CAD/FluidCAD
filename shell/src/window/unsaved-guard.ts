import path from 'path';
import type { DirtyFile, DirtyProbe } from '../../../launcher/src/projects/dirty-files';

/**
 * Asked before anything tears down a project's page: Close Project, closing
 * the window, quitting, and a pin change that reopens the project. The page's
 * Monaco buffers live only in the renderer, and none of those paths used to
 * ask — a window closed with unsaved edits simply lost them. With Close
 * Project an everyday action, that gap would bite daily.
 *
 * The engine already knows which buffers are dirty: the page reports them
 * (`editor-dirty-state`) and `GET /api/editor/dirty-files` lists them, on
 * every engine the app supports. The shell asks that, and only prompts when
 * there is something to lose. Save All goes through the page's own `save-all`
 * menu command — the same path as File › Save All — and the shell polls until
 * the list comes back clean, or gives up and says which files stayed dirty.
 *
 * The prompts and the decision are pure; native dialogs cannot be driven from
 * a test, so everything around them is injected ({@link GuardIO}).
 */

export type { DirtyFile, DirtyProbe } from '../../../launcher/src/projects/dirty-files';

export type TeardownAction = 'close-project' | 'close-window' | 'quit' | 'reopen';

export type TeardownAnswer = 'save-all' | 'discard' | 'proceed' | 'cancel';

/** A native message box, described. `answers[i]` is what pressing `buttons[i]` means. */
export type TeardownPrompt = {
  message: string;
  detail: string;
  buttons: string[];
  answers: TeardownAnswer[];
  defaultId: number;
  cancelId: number;
};

export type GuardContext = { workspacePath: string; action: TeardownAction };

const PROCEED_LABEL: Record<TeardownAction, string> = {
  'close-project': 'Close Project',
  'close-window': 'Close Window',
  quit: 'Quit',
  reopen: 'Switch Engine',
};

/** Save All waits this long for the page to report its buffers clean. */
export const SAVE_TIMEOUT_MS = 5_000;
export const SAVE_POLL_MS = 250;

/** At most this many file names in a prompt; the rest are counted. */
const MAX_LISTED = 8;

function fileList(files: DirtyFile[], workspacePath: string): string {
  const names = files.map((file) => {
    const relative = path.relative(workspacePath, file.path);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file.path;
  });
  const shown = names.slice(0, MAX_LISTED).map((name) => `  ${name}`);
  if (names.length > MAX_LISTED) {
    shown.push(`  and ${names.length - MAX_LISTED} more`);
  }
  return shown.join('\n');
}

function unsavedCount(files: DirtyFile[], workspacePath: string): string {
  return files.length === 1
    ? `${path.basename(files[0].path)} has unsaved changes`
    : `${files.length} files in ${path.basename(workspacePath)} have unsaved changes`;
}

/** What to ask before the teardown, or null when nothing can be lost. */
export function firstPrompt(probe: DirtyProbe, context: GuardContext): TeardownPrompt | null {
  if (!probe.reachable) {
    return {
      message: 'Unsaved changes in the editor may be lost',
      detail: 'The engine is not answering, so FluidCAD cannot tell whether any file has unsaved changes.',
      buttons: [PROCEED_LABEL[context.action], 'Cancel'],
      answers: ['proceed', 'cancel'],
      defaultId: 1,
      cancelId: 1,
    };
  }
  if (probe.files.length === 0) {
    return null;
  }
  return {
    message: unsavedCount(probe.files, context.workspacePath),
    detail: `${fileList(probe.files, context.workspacePath)}\n\nYour changes will be lost if you don't save them.`,
    buttons: ['Save All', "Don't Save", 'Cancel'],
    answers: ['save-all', 'discard', 'cancel'],
    defaultId: 0,
    cancelId: 2,
  };
}

/** What to ask when Save All did not leave every buffer clean, or null when it did. */
export function afterSavePrompt(probe: DirtyProbe, context: GuardContext): TeardownPrompt | null {
  if (probe.reachable && probe.files.length === 0) {
    return null;
  }
  const detail = probe.reachable
    ? `${fileList(probe.files, context.workspacePath)}\n\nThese files still have changes that were not saved.`
    : 'The engine stopped answering while saving, so FluidCAD cannot tell whether every file was saved.';
  return {
    message: probe.reachable ? `${probe.files.length === 1 ? '1 file' : `${probe.files.length} files`} could not be saved` : 'Some files may not have been saved',
    detail,
    buttons: [`${PROCEED_LABEL[context.action]} Anyway`, 'Cancel'],
    answers: ['proceed', 'cancel'],
    defaultId: 1,
    cancelId: 1,
  };
}

/** The answer a pressed button stands for; anything unexpected is Cancel. */
export function answerOf(prompt: TeardownPrompt, response: number): TeardownAnswer {
  return prompt.answers[response] ?? 'cancel';
}

export type GuardIO = {
  probe(): Promise<DirtyProbe>;
  /** Show `prompt` as a sheet on the window; resolves to the pressed button's index. */
  ask(prompt: TeardownPrompt): Promise<number>;
  /** Tell the page to save every dirty buffer (the `save-all` menu command). */
  saveAll(): void;
  sleep(ms: number): Promise<void>;
};

/** True when the teardown may go ahead; false when the user chose Cancel. */
export async function confirmTeardown(io: GuardIO, context: GuardContext): Promise<boolean> {
  const probe = await io.probe();
  const prompt = firstPrompt(probe, context);
  if (!prompt) {
    return true;
  }
  const answer = answerOf(prompt, await io.ask(prompt));
  if (answer === 'cancel') {
    return false;
  }
  if (answer !== 'save-all') {
    return true;
  }
  io.saveAll();
  let after: DirtyProbe = probe;
  for (let waited = 0; waited < SAVE_TIMEOUT_MS; waited += SAVE_POLL_MS) {
    await io.sleep(SAVE_POLL_MS);
    after = await io.probe();
    if (after.reachable && after.files.length === 0) {
      return true;
    }
  }
  const second = afterSavePrompt(after, context);
  return !second || answerOf(second, await io.ask(second)) === 'proceed';
}

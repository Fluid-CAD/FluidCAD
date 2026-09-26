import { describe, expect, it, vi } from 'vitest';
import {
  SAVE_POLL_MS,
  SAVE_TIMEOUT_MS,
  afterSavePrompt,
  answerOf,
  confirmTeardown,
  firstPrompt,
  type DirtyProbe,
  type GuardIO,
  type TeardownPrompt,
} from '../src/window/unsaved-guard';

const context = { workspacePath: '/home/you/cad/bracket', action: 'close-project' as const };
const dirty = (...names: string[]): DirtyProbe => ({
  reachable: true,
  files: names.map((name) => ({ path: `/home/you/cad/bracket/${name}`, lastModifiedMs: 1 })),
});
const clean: DirtyProbe = { reachable: true, files: [] };
const unreachable: DirtyProbe = { reachable: false };

/** A guard whose probe answers from `probes` in turn and whose dialogs press `presses` in turn. */
function io(probes: DirtyProbe[], presses: string[]) {
  const asked: TeardownPrompt[] = [];
  const saveAll = vi.fn();
  const guard: GuardIO = {
    probe: vi.fn(async () => (probes.length > 1 ? probes.shift()! : probes[0] ?? clean)),
    ask: vi.fn(async (prompt: TeardownPrompt) => {
      asked.push(prompt);
      const label = presses.shift();
      const index = prompt.buttons.indexOf(label!);
      if (index < 0) {
        throw new Error(`no "${label}" in ${prompt.buttons.join(', ')}`);
      }
      return index;
    }),
    saveAll,
    sleep: vi.fn(async () => undefined),
  };
  return { guard, asked, saveAll };
}

describe('the prompts', () => {
  it('asks nothing when every buffer is saved', () => {
    expect(firstPrompt(clean, context)).toBeNull();
  });

  it('names the file, or counts the files, that would be lost', () => {
    const one = firstPrompt(dirty('bracket.part.js'), context)!;
    expect(one.message).toBe('bracket.part.js has unsaved changes');
    expect(one.buttons).toEqual(['Save All', "Don't Save", 'Cancel']);
    expect(one.answers).toEqual(['save-all', 'discard', 'cancel']);
    const two = firstPrompt(dirty('a.part.js', 'lib/b.js'), context)!;
    expect(two.message).toBe('2 files in bracket have unsaved changes');
    expect(two.detail).toContain('  a.part.js\n  lib/b.js');
  });

  it('lists at most eight names', () => {
    const many = firstPrompt(dirty(...Array.from({ length: 11 }, (_, i) => `f${i}.js`)), context)!;
    expect(many.detail).toContain('and 3 more');
    expect(many.detail).not.toContain('f8.js');
  });

  it('asks a plain confirmation when the engine cannot answer', () => {
    const prompt = firstPrompt(unreachable, { ...context, action: 'quit' })!;
    expect(prompt.message).toBe('Unsaved changes in the editor may be lost');
    expect(prompt.buttons).toEqual(['Quit', 'Cancel']);
    expect(prompt.cancelId).toBe(1);
  });

  it('says which files stayed dirty after Save All', () => {
    expect(afterSavePrompt(clean, context)).toBeNull();
    const stuck = afterSavePrompt(dirty('a.part.js'), context)!;
    expect(stuck.message).toBe('1 file could not be saved');
    expect(stuck.buttons).toEqual(['Close Project Anyway', 'Cancel']);
  });

  it('treats an unexpected response as Cancel', () => {
    expect(answerOf(firstPrompt(dirty('a.js'), context)!, 7)).toBe('cancel');
  });
});

describe('confirmTeardown', () => {
  it('goes ahead without a question when nothing is dirty', async () => {
    const { guard, asked } = io([clean], []);
    expect(await confirmTeardown(guard, context)).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it("goes ahead on Don't Save, and stops on Cancel", async () => {
    expect(await confirmTeardown(io([dirty('a.js')], ["Don't Save"]).guard, context)).toBe(true);
    expect(await confirmTeardown(io([dirty('a.js')], ['Cancel']).guard, context)).toBe(false);
  });

  it('saves everything, then goes ahead once the buffers come back clean', async () => {
    const { guard, saveAll, asked } = io([dirty('a.js'), dirty('a.js'), clean], ['Save All']);
    expect(await confirmTeardown(guard, context)).toBe(true);
    expect(saveAll).toHaveBeenCalledTimes(1);
    expect(asked).toHaveLength(1);
  });

  it('gives up waiting after five seconds and asks again, naming what stayed dirty', async () => {
    const { guard, asked } = io([dirty('a.js')], ['Save All', 'Cancel']);
    expect(await confirmTeardown(guard, context)).toBe(false);
    expect(guard.sleep).toHaveBeenCalledTimes(SAVE_TIMEOUT_MS / SAVE_POLL_MS);
    expect(asked[1].message).toBe('1 file could not be saved');

    const anyway = io([dirty('a.js')], ['Save All', 'Close Project Anyway']);
    expect(await confirmTeardown(anyway.guard, context)).toBe(true);
  });

  it('confirms a teardown whose engine died, when the user says so', async () => {
    expect(await confirmTeardown(io([unreachable], ['Close Project']).guard, context)).toBe(true);
    expect(await confirmTeardown(io([unreachable], ['Cancel']).guard, context)).toBe(false);
  });
});

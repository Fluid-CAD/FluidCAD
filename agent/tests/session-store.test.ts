import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, type SessionRecord } from '../src/session-store.ts';

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-agent-store-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function record(id: string, title = 'A chat'): SessionRecord {
  return {
    schemaVersion: 1,
    id,
    title,
    createdAt: '2026-11-17T10:00:00.000Z',
    updatedAt: '2026-11-17T10:00:01.000Z',
    agent: { kind: 'claude', ref: '4b8f2b8e-6f2d-4a51-9d8f-0d7c1c0f3e11', model: 'haiku' },
    messages: [
      {
        id: 'u1',
        role: 'user',
        turnId: 't1',
        createdAt: '2026-11-17T10:00:00.500Z',
        parts: [{ type: 'text', id: 'p1', text: 'what is in this model?' }],
      },
    ],
    turns: [{ id: 't1', userMessageId: 'u1', revertible: false, endedAt: '2026-11-17T10:00:01.000Z', endReason: 'done' }],
  };
}

describe('SessionStore', () => {
  it('stores sessions under .fluidcad/agent/sessions/<id>/ and reads them back', () => {
    const store = SessionStore.forWorkspace(workspace);
    expect(store.root).toBe(path.join(workspace, '.fluidcad', 'agent', 'sessions'));
    const id = '0c7e6c38-5d0b-4f4e-9f0a-2a7c8f6c1b11';
    store.write(record(id));
    expect(fs.existsSync(path.join(store.root, id, 'session.json'))).toBe(true);
    expect(store.read(id)).toEqual(record(id));
    expect(store.listIds()).toEqual([id]);

    store.writeFile(id, 'shot.png', Buffer.from([1, 2, 3]));
    expect(fs.readFileSync(path.join(store.root, id, 'files', 'shot.png'))).toEqual(Buffer.from([1, 2, 3]));

    store.delete(id);
    expect(store.listIds()).toEqual([]);
    expect(store.read(id)).toBeNull();
  });

  it('replaces session.json atomically and leaves no temp file behind', () => {
    const store = SessionStore.forWorkspace(workspace);
    const id = 'a1b2c3';
    store.write(record(id, 'first'));
    const file = path.join(store.root, id, 'session.json');
    const before = fs.readFileSync(file, 'utf8');

    // A failure between writing the temp file and the rename keeps the old file whole.
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk gone');
    });
    expect(() => store.write(record(id, 'second'))).toThrow('disk gone');
    rename.mockRestore();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(store.root, id))).toEqual(['session.json']);

    store.write(record(id, 'third'));
    expect(store.read(id)?.title).toBe('third');
    expect(fs.readdirSync(path.join(store.root, id))).toEqual(['session.json']);
  });

  it('ignores unreadable or foreign files', () => {
    const store = SessionStore.forWorkspace(workspace);
    fs.mkdirSync(path.join(store.root, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(store.root, 'broken', 'session.json'), '{ not json');
    fs.mkdirSync(path.join(store.root, 'other'), { recursive: true });
    fs.writeFileSync(path.join(store.root, 'other', 'session.json'), JSON.stringify({ ...record('x'), id: 'x' }));
    expect(store.read('broken')).toBeNull();
    // The id inside must match the folder.
    expect(store.read('other')).toBeNull();
  });

  it('refuses ids and file names that could leave the session folder', () => {
    const store = SessionStore.forWorkspace(workspace);
    expect(SessionStore.isSessionId('../x')).toBe(false);
    expect(SessionStore.isSessionId('a/b')).toBe(false);
    expect(() => store.sessionDir('..')).toThrow();
    expect(store.filePath('abc', '../session.json')).toBeNull();
    expect(store.filePath('abc', '.hidden.png')).toBeNull();
    expect(store.filePath('abc', 'a/b.png')).toBeNull();
    expect(store.filePath('abc', 'ok-1.png')).toBe(path.join(store.root, 'abc', 'files', 'ok-1.png'));
  });
});

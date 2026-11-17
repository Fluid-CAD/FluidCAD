// Chat sessions on disk (docs/agent-chat-plan.md §7.5):
//
//   <workspace>/.fluidcad/agent/sessions/<id>/session.json
//   <workspace>/.fluidcad/agent/sessions/<id>/files/          images
//
// `session.json` is written atomically (temp file + rename), so a crash or
// an OCC abort mid-write leaves the previous version, never a torn file.
// `.fluidcad/` is gitignored by `fluidcad init`; nothing here is a secret.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, ChatMessage, TurnRecord } from './types.ts';

export const SESSION_SCHEMA_VERSION = 1;

export type SessionRecord = {
  schemaVersion: 1;
  id: string;
  title: string;
  /** The user renamed the session: the first message no longer sets the title. */
  titleSetByUser?: boolean;
  createdAt: string;
  updatedAt: string;
  agent: {
    kind: AgentKind;
    /** Claude session UUID or Codex thread id; null until the CLI has the conversation. */
    ref: string | null;
    /** The model last used; null for the CLI's default. */
    model: string | null;
  };
  messages: ChatMessage[];
  turns: TurnRecord[];
  /** Set when an engine restart cut a turn off; cleared by the next turn. */
  interrupted?: { reason: string };
};

const SESSION_FILE = 'session.json';
const FILES_DIR = 'files';
/** Session ids are ours (UUIDs); anything else in a URL is refused before it reaches the disk. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** File names under `files/`: no separators, no leading dot. */
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class SessionStore {
  readonly root: string;

  /** `root` is `<workspace>/.fluidcad/agent/sessions`. */
  constructor(root: string) {
    this.root = root;
  }

  static forWorkspace(workspacePath: string): SessionStore {
    return new SessionStore(path.join(workspacePath, '.fluidcad', 'agent', 'sessions'));
  }

  static isSessionId(id: string): boolean {
    return SESSION_ID_PATTERN.test(id);
  }

  static isFileName(name: string): boolean {
    return FILE_NAME_PATTERN.test(name) && !name.includes('..');
  }

  sessionDir(id: string): string {
    if (!SessionStore.isSessionId(id)) {
      throw new Error(`Invalid session id: ${id}`);
    }
    return path.join(this.root, id);
  }

  filesDir(id: string): string {
    return path.join(this.sessionDir(id), FILES_DIR);
  }

  /** Absolute path of `name` under the session's `files/`; null for a name that is not a plain file name. */
  filePath(id: string, name: string): string | null {
    if (!SessionStore.isFileName(name)) {
      return null;
    }
    return path.join(this.filesDir(id), name);
  }

  /** Every session id with a `session.json`. */
  listIds(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && SessionStore.isSessionId(e.name))
      .filter((e) => fs.existsSync(path.join(this.root, e.name, SESSION_FILE)))
      .map((e) => e.name);
  }

  /** The stored session, or null when it is missing or unreadable. */
  read(id: string): SessionRecord | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.sessionDir(id), SESSION_FILE), 'utf8'));
      return parseRecord(raw, id);
    } catch {
      return null;
    }
  }

  /** Writes `session.json` through a temp file and a rename. */
  write(record: SessionRecord): void {
    const dir = this.sessionDir(record.id);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, SESSION_FILE);
    const temp = path.join(dir, `.${SESSION_FILE}.${process.pid}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(record), 'utf8');
      fs.renameSync(temp, target);
    } catch (e) {
      fs.rmSync(temp, { force: true });
      throw e;
    }
  }

  /** Stores `data` as `name` under the session's `files/`. */
  writeFile(id: string, name: string, data: Buffer): string {
    const file = this.filePath(id, name);
    if (!file) {
      throw new Error(`Invalid file name: ${name}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return file;
  }

  delete(id: string): void {
    fs.rmSync(this.sessionDir(id), { recursive: true, force: true });
  }
}

function parseRecord(raw: any, id: string): SessionRecord | null {
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== SESSION_SCHEMA_VERSION || raw.id !== id) {
    return null;
  }
  const kind = raw.agent?.kind;
  if (kind !== 'claude' && kind !== 'codex') {
    return null;
  }
  return {
    schemaVersion: 1,
    id,
    title: typeof raw.title === 'string' ? raw.title : '',
    ...(raw.titleSetByUser === true ? { titleSetByUser: true } : {}),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
    agent: {
      kind,
      ref: typeof raw.agent.ref === 'string' ? raw.agent.ref : null,
      model: typeof raw.agent.model === 'string' ? raw.agent.model : null,
    },
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    turns: Array.isArray(raw.turns) ? raw.turns : [],
    ...(raw.interrupted && typeof raw.interrupted.reason === 'string' ? { interrupted: { reason: raw.interrupted.reason } } : {}),
  };
}

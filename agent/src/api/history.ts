// The API agent's conversation as the model sees it (docs/agent-chat-plan.md
// §20.5): AI SDK `ModelMessage[]`, kept beside `session.json` and written
// atomically (temp file + rename). The transcript the page shows is the
// session's own; this is what each request replays.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';

/** The file name the run's `ref` gives, in the session's folder. */
export const HISTORY_FILE = 'api-history.json';
const SCHEMA_VERSION = 1;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type HistoryFile = { schemaVersion: 1; provider: string; messages: ModelMessage[] };

/** `name` under `dir`, or null for a name that is not a plain file name. */
export function historyPath(dir: string, name: string): string | null {
  return FILE_NAME_PATTERN.test(name) && !name.includes('..') ? path.join(dir, name) : null;
}

/** The stored history: its messages, or null when it is missing or unreadable. */
export function readHistory(file: string): { provider: string; messages: ModelMessage[] } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.messages)) {
      return null;
    }
    const messages = (raw.messages as unknown[]).filter(isModelMessage) as ModelMessage[];
    return { provider: typeof raw.provider === 'string' ? raw.provider : '', messages };
  } catch {
    return null;
  }
}

/** Writes the history through a temp file and a rename; binary data goes as base64. */
export function writeHistory(file: string, provider: string, messages: ModelMessage[]): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const body: HistoryFile = { schemaVersion: SCHEMA_VERSION, provider, messages };
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(body, binaryAsBase64), 'utf8');
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw e;
  }
}

function isModelMessage(value: unknown): boolean {
  const m = value as { role?: unknown; content?: unknown } | null;
  return !!m && typeof m === 'object' && ['system', 'user', 'assistant', 'tool'].includes(m.role as string) && (typeof m.content === 'string' || Array.isArray(m.content));
}

/** A JSON replacer: Uint8Array, ArrayBuffer and Buffer become base64 strings (file parts take those). */
function binaryAsBase64(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('base64');
  }
  // Buffer.prototype.toJSON runs before a replacer sees the value.
  const v = value as { type?: unknown; data?: unknown } | null;
  if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data) && Object.keys(v).length === 2) {
    return Buffer.from(v.data as number[]).toString('base64');
  }
  return value;
}

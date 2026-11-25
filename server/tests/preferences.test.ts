import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { loadPreferences, preferredNewProjectUnit, resetPreferences, savePreferences, updateAgentPreferences, type Preferences } from '../src/preferences.ts';
import { createPreferencesRouter } from '../src/routes/preferences.ts';
import { AgentCredentials } from '../src/agent-credentials.ts';

// The preferences file lives under the platform config dir; on Linux that is
// $XDG_CONFIG_HOME, so each test gets a fresh temp dir and touches nothing
// of the developer's own.

let tmp: string;
let savedXdg: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-prefs-'));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  // The agent's key store ($FLUIDCAD_HOME/agent-credentials.json) too.
  savedHome = process.env.FLUIDCAD_HOME;
  process.env.FLUIDCAD_HOME = path.join(tmp, 'home');
});

afterEach(() => {
  if (savedXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = savedXdg;
  }
  if (savedHome === undefined) {
    delete process.env.FLUIDCAD_HOME;
  } else {
    process.env.FLUIDCAD_HOME = savedHome;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const onLinux = process.platform === 'linux';

async function withServer<T>(run: (base: string) => Promise<T>, onSaved?: (prefs: Preferences) => void): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use('/api', createPreferencesRouter(onSaved));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    return await run(`http://127.0.0.1:${port}/api`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function postStatus(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

describe.runIf(onLinux)('preferences — the global materials list', () => {
  it('starts empty, round-trips a valid map through the route and drops an invalid one', async () => {
    expect((await loadPreferences()).materials).toEqual({});
    await withServer(async (base) => {
      const map = { 'alloy-steel': { name: 'Alloy Steel', density: 7.7, densityUnit: 'g/mm³' }, pine: { name: 'Pine', density: 0.5 } };
      expect((await post(`${base}/preferences`, { materials: map })).materials).toEqual(map);
      expect((await loadPreferences()).materials).toEqual(map);
      // A bad map is ignored like any out-of-range value; the stored one stays.
      expect((await post(`${base}/preferences`, { materials: { bad: { name: '', density: 1 } } })).materials).toEqual(map);
      expect((await post(`${base}/preferences`, { materials: {} })).materials).toEqual({});
    });
  });

  it('drops a hand-edited map that fails the fluidcad.json rules when loading', async () => {
    const prefs = await loadPreferences();
    await savePreferences({ ...prefs, materials: { x: { name: 'X', density: -1 } } as never });
    expect((await loadPreferences()).materials).toEqual({});
  });
});

describe.runIf(onLinux)('preferences — the Settings dialog keys', () => {
  it('starts from the defaults the dialog shows', async () => {
    const prefs = await loadPreferences();
    expect(prefs.editorFontFamily).toBe('');
    expect(prefs.editorFontSize).toBe(13);
    expect(prefs.editorWordWrap).toBe(false);
    expect(prefs.snapRadiusPx).toBe(15);
    expect(prefs.pickRadiusPx).toBe(12);
    expect(prefs.defaultProjectUnit).toBe('mm');
    expect(prefs.editorOpen).toBe(false);
    expect(prefs.timelineSketchChildren).toBe('all');
    expect(prefs.timelineShowConstraints).toBe(true);
    expect(prefs.timelineShowRegions).toBe(false);
  });

  it('merges one key per POST, clamps the numbers and refuses a font family that is not a plain name', async () => {
    await withServer(async (base) => {
      let prefs = await post(`${base}/preferences`, { editorFontSize: 400 });
      expect(prefs.editorFontSize).toBe(40);
      prefs = await post(`${base}/preferences`, { snapRadiusPx: 0.4, pickRadiusPx: 9.6 });
      expect(prefs.snapRadiusPx).toBe(2);
      expect(prefs.pickRadiusPx).toBe(10);
      prefs = await post(`${base}/preferences`, { editorFontFamily: 'JetBrains Mono' });
      expect(prefs.editorFontFamily).toBe('JetBrains Mono');
      prefs = await post(`${base}/preferences`, { editorFontFamily: 'x; url(evil)' });
      expect(prefs.editorFontFamily).toBe('JetBrains Mono');
      prefs = await post(`${base}/preferences`, { editorWordWrap: true });
      expect(prefs.editorWordWrap).toBe(true);
      prefs = await post(`${base}/preferences`, { editorWordWrap: 'yes' });
      expect(prefs.editorWordWrap).toBe(true);
      prefs = await post(`${base}/preferences`, { defaultProjectUnit: 'in' });
      expect(prefs.defaultProjectUnit).toBe('in');
      prefs = await post(`${base}/preferences`, { defaultProjectUnit: 'furlong' });
      expect(prefs.defaultProjectUnit).toBe('in');
      prefs = await post(`${base}/preferences`, { timelineSketchChildren: 'editable', timelineShowConstraints: false, timelineShowRegions: true });
      expect(prefs.timelineSketchChildren).toBe('editable');
      expect(prefs.timelineShowConstraints).toBe(false);
      expect(prefs.timelineShowRegions).toBe(true);
      prefs = await post(`${base}/preferences`, { timelineSketchChildren: 'some', timelineShowConstraints: 'no', timelineShowRegions: 1 });
      expect(prefs.timelineSketchChildren).toBe('editable');
      expect(prefs.timelineShowConstraints).toBe(false);
      expect(prefs.timelineShowRegions).toBe(true);
      // Every earlier key survived the later merges.
      expect(prefs.editorFontSize).toBe(40);
      expect(prefs.snapRadiusPx).toBe(2);
    });
  });

  it('keeps the Quick Find pins as one list, null for the defaults, and drops anything else', async () => {
    expect((await loadPreferences()).quickFindPins).toBeNull();
    await withServer(async (base) => {
      let prefs = await post(`${base}/preferences`, { quickFindPins: ['part:extrude', 'sketch:line', 'part:extrude', '  ', 7] });
      expect(prefs.quickFindPins).toEqual(['part:extrude', 'sketch:line']);
      expect((await loadPreferences()).quickFindPins).toEqual(['part:extrude', 'sketch:line']);
      // Not a list: the stored pins stay.
      prefs = await post(`${base}/preferences`, { quickFindPins: 'part:hole' });
      expect(prefs.quickFindPins).toEqual(['part:extrude', 'sketch:line']);
      // An empty list is a choice (nothing pinned); null is the defaults again.
      prefs = await post(`${base}/preferences`, { quickFindPins: [] });
      expect(prefs.quickFindPins).toEqual([]);
      prefs = await post(`${base}/preferences`, { quickFindPins: null });
      expect(prefs.quickFindPins).toBeNull();
    });
  });

  it('reset puts the file back to the defaults and answers with them', async () => {
    await withServer(async (base) => {
      await post(`${base}/preferences`, { theme: 'fluidcad-light', editorFontSize: 20, defaultProjectUnit: 'ft', showGrid: false });
      const reset = await post(`${base}/preferences/reset`, {});
      expect(reset.theme).toBe('fluidcad-dark');
      expect(reset.editorFontSize).toBe(13);
      expect(reset.defaultProjectUnit).toBe('mm');
      expect(reset.showGrid).toBe(true);
      const onDisk = await loadPreferences();
      expect(onDisk).toEqual(reset);
    });
  });

  it('the worker count defaults to one per CPU up to eight, stays within [1, CPUs] and reaches the engine on every save', async () => {
    const cpus = os.availableParallelism();
    const byDefault = Math.min(cpus, 8);
    expect((await loadPreferences()).maxWorkers).toBe(byDefault);
    const heard: number[] = [];
    await withServer(async (base) => {
      let prefs = await post(`${base}/preferences`, { maxWorkers: 0 });
      expect(prefs.maxWorkers).toBe(1);
      prefs = await post(`${base}/preferences`, { maxWorkers: cpus + 50 });
      expect(prefs.maxWorkers).toBe(cpus);
      prefs = await post(`${base}/preferences`, { maxWorkers: 1.4 });
      expect(prefs.maxWorkers).toBe(1);
      prefs = await post(`${base}/preferences`, { maxWorkers: 'many' });
      expect(prefs.maxWorkers).toBe(1);
      const reset = await post(`${base}/preferences/reset`, {});
      expect(reset.maxWorkers).toBe(byDefault);
    }, (prefs) => heard.push(prefs.maxWorkers));
    // Every write, the ignored value and the reset included, is handed on.
    expect(heard).toEqual([1, cpus, 1, 1, byDefault]);
  });

  it('the unit for new projects is null for mm and the stored unit otherwise', async () => {
    expect(await preferredNewProjectUnit()).toBeNull();
    const prefs = await loadPreferences();
    await savePreferences({ ...prefs, defaultProjectUnit: 'in' });
    expect(await preferredNewProjectUnit()).toBe('in');
    await resetPreferences();
    expect(await preferredNewProjectUnit()).toBeNull();
  });
});

describe.runIf(onLinux)('preferences — the agent panel', () => {
  it('defaults to no agent and asking before edits, and merges valid fields one by one', async () => {
    expect((await loadPreferences()).agent).toEqual({ defaultAgent: null, permissionMode: 'ask' });
    await withServer(async (base) => {
      let prefs = await post(`${base}/preferences`, {
        agent: { defaultAgent: 'claude', claudePath: ' /opt/claude/bin/claude ', claudeModel: 'sonnet', effort: 'high' },
      });
      expect(prefs.agent).toEqual({
        defaultAgent: 'claude',
        claudePath: '/opt/claude/bin/claude',
        claudeModel: 'sonnet',
        effort: 'high',
        permissionMode: 'ask',
      });
      // Invalid values are ignored; the rest of the stored key stays.
      prefs = await post(`${base}/preferences`, {
        agent: { defaultAgent: 'gpt', claudeModel: '--evil flag', effort: 'max', permissionMode: 'yolo' },
      });
      expect(prefs.agent).toMatchObject({ defaultAgent: 'claude', claudeModel: 'sonnet', effort: 'high', permissionMode: 'ask' });
      // Empty or null clears an optional field.
      prefs = await post(`${base}/preferences`, { agent: { claudePath: '', claudeModel: null, effort: null, permissionMode: 'auto-edits' } });
      expect(prefs.agent).toEqual({ defaultAgent: 'claude', permissionMode: 'auto-edits' });
      expect((await loadPreferences()).agent).toEqual(prefs.agent);

      // Each agent's own effort: Claude Code's `--effort` choices, and any
      // reasoning effort word for Codex (each model lists its own).
      prefs = await post(`${base}/preferences`, { agent: { claudeEffort: 'max', codexEffort: 'ultra' } });
      expect(prefs.agent).toMatchObject({ claudeEffort: 'max', codexEffort: 'ultra' });
      prefs = await post(`${base}/preferences`, { agent: { claudeEffort: 'ultra', codexEffort: '--model x' } });
      expect(prefs.agent).toMatchObject({ claudeEffort: 'max', codexEffort: 'ultra' });
      prefs = await post(`${base}/preferences`, { agent: { claudeEffort: 'xhigh', codexEffort: '' } });
      expect(prefs.agent.claudeEffort).toBe('xhigh');
      expect(prefs.agent.codexEffort).toBeUndefined();
      const reset = await post(`${base}/preferences/reset`, {});
      expect(reset.agent).toEqual({ defaultAgent: null, permissionMode: 'ask' });
    });
  });

  it('keeps "Always" for installs as true or not at all, and updateAgentPreferences merges it like a POST', async () => {
    await withServer(async (base) => {
      let prefs = await post(`${base}/preferences`, { agent: { alwaysAllowInstalls: 'yes' } });
      expect('alwaysAllowInstalls' in prefs.agent).toBe(false);
      prefs = await post(`${base}/preferences`, { agent: { alwaysAllowInstalls: true } });
      expect(prefs.agent.alwaysAllowInstalls).toBe(true);
      prefs = await post(`${base}/preferences`, { agent: { permissionMode: 'auto-edits' } });
      expect(prefs.agent.alwaysAllowInstalls).toBe(true);
      prefs = await post(`${base}/preferences`, { agent: { alwaysAllowInstalls: false } });
      expect('alwaysAllowInstalls' in prefs.agent).toBe(false);
    });
    const agent = await updateAgentPreferences({ alwaysAllowInstalls: true });
    expect(agent).toMatchObject({ permissionMode: 'auto-edits', alwaysAllowInstalls: true });
    expect((await loadPreferences()).agent.alwaysAllowInstalls).toBe(true);
  });

  it('drops the old API-key choice (Claude Code runs on the subscription only)', async () => {
    await withServer(async (base) => {
      const prefs = await post(`${base}/preferences`, { agent: { claudeIgnoreApiKey: true } });
      expect('claudeIgnoreApiKey' in prefs.agent).toBe(false);
      expect('claudeIgnoreApiKey' in (await loadPreferences()).agent).toBe(false);
    });
  });
});

describe.runIf(onLinux)('preferences — the API agent', () => {
  const ollama = { id: 'ollama', kind: 'openai-compatible', label: 'Ollama', baseURL: 'http://localhost:11434/v1/', models: ['qwen3-vl:4b'], contextWindow: 32768 };

  it('takes the api agent, a provider-qualified model and an effort, and clears them on null', async () => {
    await withServer(async (base) => {
      let prefs = await post(`${base}/preferences`, { agent: { defaultAgent: 'api', apiModel: 'anthropic/claude-opus-5-5', apiEffort: 'high' } });
      expect(prefs.agent).toMatchObject({ defaultAgent: 'api', apiModel: 'anthropic/claude-opus-5-5', apiEffort: 'high' });
      // A model without its provider, a bad provider slug, or a bad effort is ignored.
      prefs = await post(`${base}/preferences`, { agent: { apiModel: 'claude-opus-5-5', apiEffort: '--x' } });
      expect(prefs.agent).toMatchObject({ apiModel: 'anthropic/claude-opus-5-5', apiEffort: 'high' });
      prefs = await post(`${base}/preferences`, { agent: { apiModel: 'Bad_Provider/m' } });
      expect(prefs.agent.apiModel).toBe('anthropic/claude-opus-5-5');
      prefs = await post(`${base}/preferences`, { agent: { apiModel: 'openrouter/anthropic/claude-sonnet-5-5' } });
      expect(prefs.agent.apiModel).toBe('openrouter/anthropic/claude-sonnet-5-5');
      prefs = await post(`${base}/preferences`, { agent: { apiModel: null, apiEffort: '' } });
      expect('apiModel' in prefs.agent).toBe(false);
      expect('apiEffort' in prefs.agent).toBe(false);
    });
  });

  it('saves custom providers as one list, normalised, and refuses a bad one out loud with nothing saved', async () => {
    await withServer(async (base) => {
      let res = await postStatus(`${base}/preferences`, { agent: { providers: [ollama, { id: 'lmstudio', label: 'LM Studio', baseURL: 'http://localhost:1234/v1', images: true }] } });
      expect(res.status).toBe(200);
      expect(res.body.agent.providers).toEqual([
        { id: 'ollama', kind: 'openai-compatible', label: 'Ollama', baseURL: 'http://localhost:11434/v1', models: ['qwen3-vl:4b'], contextWindow: 32768 },
        { id: 'lmstudio', kind: 'openai-compatible', label: 'LM Studio', baseURL: 'http://localhost:1234/v1', images: true },
      ]);
      const refused: [unknown, string][] = [
        [[{ ...ollama, id: 'openai' }], 'built-in'],
        [[{ ...ollama, id: 'Ollama' }], 'the id must'],
        [[{ ...ollama, baseURL: 'file:///etc/passwd' }], 'http or https'],
        [[{ ...ollama, baseURL: 'javascript:alert(1)' }], 'http or https'],
        [[{ ...ollama, baseURL: 'http://user:pw@host/v1' }], 'http or https'],
        [[{ ...ollama, kind: 'anthropic' }], 'OpenAI-compatible'],
        [[{ ...ollama, label: '' }], 'the name'],
        [[{ ...ollama, label: 'x'.repeat(61) }], 'the name'],
        [[{ ...ollama, contextWindow: 10 }], 'context window'],
        [[{ ...ollama, models: ['--evil flag'] }], 'not a model name'],
        [[{ ...ollama, images: 'yes' }], 'images'],
        [[ollama, { ...ollama }], 'Two providers'],
        ['ollama', 'must be a list'],
        [Array.from({ length: 17 }, (_, i) => ({ ...ollama, id: `p${i}` })), 'At most 16'],
      ];
      for (const [providers, message] of refused) {
        res = await postStatus(`${base}/preferences`, { agent: { providers, apiEffort: 'low' } });
        expect(res.status, JSON.stringify(providers).slice(0, 80)).toBe(400);
        expect(res.body.key).toBe('agent.providers');
        expect(res.body.error).toContain(message);
      }
      // Nothing of a refused POST was saved.
      const stored = (await loadPreferences()).agent;
      expect(stored.providers?.map((p) => p.id)).toEqual(['ollama', 'lmstudio']);
      expect(stored.apiEffort).toBeUndefined();
      // An empty list removes every entry.
      res = await postStatus(`${base}/preferences`, { agent: { providers: [] } });
      expect('providers' in res.body.agent).toBe(false);
    });
  });

  it('keeps the good entries of a hand-edited file', async () => {
    const dir = path.join(tmp, 'fluidcad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ agent: { providers: [ollama, { id: 'anthropic', label: 'x', baseURL: 'http://x' }, { id: 'bad', label: 'Bad', baseURL: 'ftp://x' }] } }));
    expect((await loadPreferences()).agent.providers?.map((p) => p.id)).toEqual(['ollama']);
  });

  it('deletes the stored key of an entry that is removed, and of every entry on reset', async () => {
    const credentials = new AgentCredentials();
    await withServer(async (base) => {
      await post(`${base}/preferences`, { agent: { providers: [ollama, { ...ollama, id: 'lmstudio', label: 'LM Studio' }] } });
      credentials.write('ollama', 'local-1');
      credentials.write('lmstudio', 'local-2');
      credentials.write('anthropic', 'sk-ant-kept');
      await post(`${base}/preferences`, { agent: { providers: [{ ...ollama, id: 'lmstudio', label: 'LM Studio' }] } });
      expect(credentials.stored('ollama')).toBeNull();
      expect(credentials.stored('lmstudio')).toBe('local-2');
      // A save that does not name the list leaves it and its keys alone.
      await post(`${base}/preferences`, { agent: { apiEffort: 'low' } });
      expect(credentials.stored('lmstudio')).toBe('local-2');
      await post(`${base}/preferences/reset`, {});
      expect(credentials.stored('lmstudio')).toBeNull();
      // Built-in providers' keys are not preferences: a reset keeps them.
      expect(credentials.stored('anthropic')).toBe('sk-ant-kept');
    });
  });
});

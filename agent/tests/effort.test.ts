import { describe, expect, it } from 'vitest';
import { parseSendMessage } from '../src/router.ts';
import { defaultEffort } from '../src/runtime.ts';
import { CLAUDE_EFFORTS, isEffortFor } from '../src/types.ts';
import type { Preferences } from '../../server/dist/preferences.js';

// Every effort level each agent takes (phase 7): Claude Code's `--effort`
// choices, and whatever reasoning effort a Codex model lists.

const prefs = (agent: Partial<Preferences['agent']>): Preferences => ({ agent: { defaultAgent: null, permissionMode: 'ask', ...agent } }) as Preferences;

describe('effort levels', () => {
  it("Claude Code takes exactly its --effort choices", () => {
    expect(CLAUDE_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    for (const effort of CLAUDE_EFFORTS) {
      expect(parseSendMessage({ text: 'hi', effort }, 'claude')).toEqual({ message: { text: 'hi', effort } });
    }
    for (const effort of ['ultra', 'minimal', 'MAX', '--model', 3]) {
      expect(parseSendMessage({ text: 'hi', effort }, 'claude')).toEqual({ error: '`effort` must be one of low, medium, high, xhigh, max.' });
    }
  });

  it('Codex takes any reasoning effort word a model may list, and nothing that is not a word', () => {
    for (const effort of ['low', 'xhigh', 'max', 'ultra', 'minimal']) {
      expect(parseSendMessage({ text: 'hi', effort }, 'codex')).toEqual({ message: { text: 'hi', effort } });
    }
    for (const effort of ['High', '--effort', 'a b', 'x'.repeat(30), {}]) {
      expect('error' in parseSendMessage({ text: 'hi', effort }, 'codex')).toBe(true);
    }
  });

  it('an empty or null effort means the default', () => {
    expect(parseSendMessage({ text: 'hi', effort: '' }, 'codex')).toEqual({ message: { text: 'hi' } });
    expect(parseSendMessage({ text: 'hi', effort: null }, 'claude')).toEqual({ message: { text: 'hi' } });
  });

  it("a turn's default is the agent's own preference, else the older shared one when that agent takes it", () => {
    expect(defaultEffort('claude', prefs({ claudeEffort: 'max', codexEffort: 'ultra', effort: 'low' }))).toBe('max');
    expect(defaultEffort('codex', prefs({ claudeEffort: 'max', codexEffort: 'ultra', effort: 'low' }))).toBe('ultra');
    expect(defaultEffort('codex', prefs({ claudeEffort: 'max', effort: 'high' }))).toBe('high');
    expect(defaultEffort('claude', prefs({}))).toBeUndefined();
    // A stored value the agent does not take is not passed on.
    expect(defaultEffort('claude', prefs({ claudeEffort: 'ultra' as any }))).toBeUndefined();
    expect(isEffortFor('codex', 'ultra')).toBe(true);
    expect(isEffortFor('claude', 'ultra')).toBe(false);
  });
});

#!/usr/bin/env node
// A stand-in for `claude` in tests: answers `--version` and `auth status`,
// and speaks just enough stream-json for one run. No model, no network.
//
// FAKE_CLAUDE_MODE: ok (default) | exit1 | mcp-failed | stderr-crash
// FAKE_CLAUDE_VERSION: what --version reports (default 2.1.326).
// A user message containing "slow" starts a turn that only an interrupt ends.

import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

// FAKE_CLAUDE_LOG: a file each `auth status` and each run appends a line to,
// saying whether ANTHROPIC_API_KEY was in its environment.
function log(what) {
  if (process.env.FAKE_CLAUDE_LOG) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${what} key=${hasKey ? 'yes' : 'no'}\n`);
  }
}

if (args[0] === '--version') {
  console.log(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.326'} (Claude Code)`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  log('auth-status');
  // FAKE_CLAUDE_SUBSCRIPTION=0: no Claude subscription login is stored, so
  // only an API key signs it in. An inherited key wins over the login.
  const subscription = process.env.FAKE_CLAUDE_SUBSCRIPTION !== '0';
  const loggedIn = process.env.FAKE_CLAUDE_LOGGED_IN !== '0' && (hasKey || subscription);
  const authMethod = !loggedIn ? 'none' : hasKey ? 'api_key' : 'claude.ai';
  console.log(JSON.stringify({ loggedIn, authMethod, apiProvider: 'firstParty', email: 'someone@example.com', orgId: 'org-1', orgName: 'Org' }));
  process.exit(loggedIn ? 0 : 1);
}

log('run');
const sessionId = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1];
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
let messageCount = 0;
let slowTurn = false;

function init() {
  out({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    claude_code_version: '2.1.326',
    model: 'claude-test',
    mcp_servers: [{ name: 'fluidcad_app', status: mode === 'mcp-failed' ? 'failed' : 'connected' }],
    apiKeySource: 'none',
    capabilities: [],
    tools: ['Read', 'Glob', 'Grep'],
    // The args the CLI was started with, for the tests to read back.
    fake_args: args,
  });
}

function result(subtype, isError) {
  out({ type: 'result', subtype, is_error: isError, session_id: sessionId, usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: 0.001 });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'user') {
    if (mode === 'exit1') {
      process.exit(1);
    }
    if (mode === 'stderr-crash') {
      process.stderr.write('Error: something broke\n    at somewhere\n');
      process.exit(3);
    }
    init();
    const text = msg.message.content.find((b) => b.type === 'text')?.text ?? '';
    messageCount += 1;
    const id = `msg_${messageCount}`;
    out({ type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant', content: [] } } });
    if (text.includes('slow')) {
      slowTurn = true;
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} } } });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/p/a.js"}' } } });
      out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      return;
    }
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `echo: ${text.split('\n')[0]}` } } });
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    out({ type: 'stream_event', event: { type: 'message_stop' } });
    result('success', false);
  } else if (msg.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    if (slowTurn) {
      slowTurn = false;
      result('error_during_execution', true);
    }
  }
});
rl.on('close', () => process.exit(0));

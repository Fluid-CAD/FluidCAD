import { describe, it, expect } from 'vitest';
import { buildCliText, composeInstructions, IN_APP_PREAMBLE, workspaceStateTag } from '../src/instructions.ts';
import { SERVER_INSTRUCTIONS } from '../../mcp/dist/server.js';

describe('instructions', () => {
  it('puts the in-app preamble before the MCP server instructions, in full', () => {
    const text = composeInstructions();
    expect(text.startsWith(IN_APP_PREAMBLE)).toBe(true);
    expect(text.endsWith(SERVER_INSTRUCTIONS)).toBe(true);
    expect(IN_APP_PREAMBLE).toContain('fluidcad_app');
    expect(IN_APP_PREAMBLE).toContain('dirty-buffer');
  });

  it('appends the workspace state to the user\'s words', () => {
    const text = buildCliText({
      text: '  what is in this model?\n',
      workspace: { file: '/w/bracket.fluid.js', render: 'rendered', unit: 'mm' },
    });
    expect(text).toBe('what is in this model?\n\n<workspace_state file="/w/bracket.fluid.js" render="rendered" unit="mm"/>');
  });

  it('leaves out the file when none is open and escapes attribute values', () => {
    expect(workspaceStateTag({ file: null, render: 'none', unit: 'in' })).toBe('<workspace_state render="none" unit="in"/>');
    expect(workspaceStateTag({ file: '/w/"a"<b>&.fluid.js', render: 'compile-error', unit: 'mm' })).toBe(
      '<workspace_state file="/w/&quot;a&quot;&lt;b&gt;&amp;.fluid.js" render="compile-error" unit="mm"/>',
    );
  });
});

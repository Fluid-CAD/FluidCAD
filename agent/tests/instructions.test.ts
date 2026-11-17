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

  it('tells the CLI which files a revert put back, before the workspace state', () => {
    const text = buildCliText({
      text: 'next',
      workspace: { file: null, render: 'rendered', unit: 'mm' },
      revertedFiles: ['plate.part.js', 'new.fluid.js'],
    });
    expect(text).toBe(
      'next\n\n<reverted_changes>\n' +
        'The user reverted changes you made earlier in this conversation. These files are back to what they were ' +
        'before those changes (a file you had created no longer exists):\n' +
        '- plate.part.js\n- new.fluid.js\n</reverted_changes>\n' +
        '<workspace_state render="rendered" unit="mm"/>',
    );
    expect(IN_APP_PREAMBLE).toContain('<reverted_changes>');
    expect(buildCliText({ text: 'x', workspace: { file: null, render: 'none', unit: 'mm' }, revertedFiles: [] })).not.toContain('reverted');
  });

  it('leaves out the file when none is open and escapes attribute values', () => {
    expect(workspaceStateTag({ file: null, render: 'none', unit: 'in' })).toBe('<workspace_state render="none" unit="in"/>');
    expect(workspaceStateTag({ file: '/w/"a"<b>&.fluid.js', render: 'compile-error', unit: 'mm' })).toBe(
      '<workspace_state file="/w/&quot;a&quot;&lt;b&gt;&amp;.fluid.js" render="compile-error" unit="mm"/>',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { TimelineBreakpoint } from '../src/timeline-breakpoint.ts';
import { applyFeatureEdit } from '../src/apply-feature-edit/index.ts';

function before(code: string, text: string) {
  const offset = code.indexOf(text);
  const lines = code.slice(0, offset).split('\n');
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

async function move(code: string, text: string | null, remove?: 'passed' | 'active' | 'all', active?: { line: number; column: number }) {
  return applyFeatureEdit(code, {
    feature: 'sketch', filePath: '/model.part.js', producers: [], parts: [], imports: [],
    timelineBreakpoint: TimelineBreakpoint.capture(code, text === null ? null : before(code, text), remove, active),
  });
}

describe('atomic timeline breakpoint moves', () => {
  it('moves forwards and backwards without leaving the earlier stop behind', async () => {
    const code = "import { extrude, fillet, shell, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\nshell(1);\n";
    const forward = await move(code, 'shell(1)');
    expect(forward.error).toBeUndefined();
    expect(forward.newCode).toContain('extrude(5);\nfillet(2);\nbreakpoint();\nshell(1);');
    expect(forward.newCode.match(/breakpoint\(\)/g)).toHaveLength(1);
    // Moving back up leaves the stop further down pending: the build pauses
    // there next, once the earlier one is lifted.
    const backward = await move(forward.newCode, 'extrude(5)');
    expect(backward.newCode).toContain("from 'fluidcad/core';\nbreakpoint();\nextrude(5);\nfillet(2);\nbreakpoint();\nshell(1);");
  });

  it('continue lifts the paused stop only, falling back to the first in the file', async () => {
    const code = "import { extrude, fillet, shell, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\nbreakpoint();\nshell(1);\n";
    const first = await move(code, null, 'active', { line: 3, column: 1 });
    expect(first.newCode).toBe("import { extrude, fillet, shell, breakpoint } from 'fluidcad/core';\nextrude(5);\nfillet(2);\nbreakpoint();\nshell(1);\n");
    const second = await move(code, null, 'active', { line: 5, column: 1 });
    expect(second.newCode).toBe("import { extrude, fillet, shell, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\nshell(1);\n");
    const unlocated = await move(code, null, 'active');
    expect(unlocated.newCode).toBe(first.newCode);
    const stale = await move(code, null, 'active', { line: 4, column: 1 });
    expect(stale.newCode).toBe(first.newCode);
    const none = await move("extrude(5);\n", null, 'active');
    expect(none.newCode).toBe("extrude(5);\n");
    expect(none.error).toBeUndefined();
  });

  it('keeps a pending stop the apply of an edit dialog did not pause on', async () => {
    const code = "import { extrude, fillet, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\nbreakpoint();\n";
    const result = await applyFeatureEdit(code, {
      feature: 'fillet', filePath: '/model.part.js', producers: [], parts: [], imports: [],
      value: 3, edit: { line: 4 }, clearBreakpoints: { line: 3, column: 1 },
    } as never);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe("import { extrude, fillet, breakpoint } from 'fluidcad/core';\nextrude(5);\nfillet(3);\nbreakpoint();\n");
  });

  it('resolves a full multiline chained statement inside the correct part', async () => {
    const code = "import { part, extrude, fillet } from 'fluidcad/core';\npart('A', () => {\n  const e = extrude(\n    5\n  ).name('Base');\n  fillet(2);\n});\n";
    const result = await move(code, 'extrude(');
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain("part('A', () => {\n  breakpoint();\n  const e = extrude(");
    expect(result.newCode).toContain('breakpoint,');
  });

  it('distinguishes features on the same line and preserves their neighbors', async () => {
    const code = "import { part, extrude, fillet, shell, breakpoint } from 'fluidcad/core';\npart('A', () => { extrude(5); breakpoint(); fillet(2); shell(1); });";
    const result = await move(code, 'shell(1)');
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('extrude(5);  fillet(2); breakpoint();');
    expect(result.newCode).toContain('shell(1); });');
    expect(result.newCode.match(/breakpoint\(\)/g)).toHaveLength(1);
  });

  it('continues by removing standalone and inline stops without deleting model code', async () => {
    const code = "import { breakpoint } from 'fluidcad/core';\nbreakpoint();\nextrude(5); breakpoint(); fillet(2);\n// breakpoint(); is just a comment\n";
    const result = await move(code, null);
    // The last stop takes its import with it; the comment calls nothing.
    expect(result.newCode).toBe("extrude(5);  fillet(2);\n// breakpoint(); is just a comment\n");
  });

  it('refuses a move on a changed live buffer, but still continues on it', async () => {
    const code = 'extrude(5);\nbreakpoint();\nfillet(2);';
    const changed = code.replace('5', '10');
    const refused = await TimelineBreakpoint.apply(changed, TimelineBreakpoint.capture(code, before(code, 'fillet')));
    expect(refused.error).toContain('file changed');
    expect(refused.newCode).toBe(changed);
    // A removal is resolved against the buffer it edits — nothing to go stale.
    const continued = await TimelineBreakpoint.apply(changed, TimelineBreakpoint.capture(code, null));
    expect(continued.error).toBeUndefined();
    expect(continued.newCode).toBe('extrude(10);\nfillet(2);');
  });

  it('refuses invalid targets without removing the existing stop', async () => {
    const code = "import { extrude, breakpoint } from 'fluidcad/core';\nbreakpoint();\nextrude(5);";
    const result = await TimelineBreakpoint.apply(code, TimelineBreakpoint.capture(code, { line: 1, column: 1 }));
    expect(result.error).toBeDefined();
    expect(result.newCode).toBe(code);
  });

  it('does not sweep unrelated unused selections while navigating', async () => {
    const code = "import { select, extrude, fillet } from 'fluidcad/core';\nconst unused = select('edge');\nextrude(5);\nfillet(2);";
    const result = await move(code, 'fillet(2)');
    expect(result.newCode).toContain("const unused = select('edge');");
  });
});

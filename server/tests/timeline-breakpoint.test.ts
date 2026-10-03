import { describe, expect, it } from 'vitest';
import { TimelineBreakpoint } from '../src/timeline-breakpoint.ts';
import { applyFeatureEdit } from '../src/apply-feature-edit/index.ts';

function before(code: string, text: string) {
  const offset = code.indexOf(text);
  const lines = code.slice(0, offset).split('\n');
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

async function move(code: string, text: string | null) {
  return applyFeatureEdit(code, {
    feature: 'sketch', filePath: '/model.part.js', producers: [], parts: [], imports: [],
    timelineBreakpoint: TimelineBreakpoint.capture(code, text === null ? null : before(code, text)),
  });
}

describe('atomic timeline breakpoint moves', () => {
  it('moves forwards and backwards without leaving the earlier stop behind', async () => {
    const code = "import { extrude, fillet, shell, breakpoint } from 'fluidcad/core';\nextrude(5);\nbreakpoint();\nfillet(2);\nshell(1);\n";
    const forward = await move(code, 'shell(1)');
    expect(forward.error).toBeUndefined();
    expect(forward.newCode).toContain('extrude(5);\nfillet(2);\nbreakpoint();\nshell(1);');
    expect(forward.newCode.match(/breakpoint\(\)/g)).toHaveLength(1);
    const backward = await move(forward.newCode, 'extrude(5)');
    expect(backward.newCode).toContain("from 'fluidcad/core';\nbreakpoint();\nextrude(5);\nfillet(2);\nshell(1);");
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
    expect(result.newCode).toBe("import { breakpoint } from 'fluidcad/core';\nextrude(5);  fillet(2);\n// breakpoint(); is just a comment\n");
  });

  it('refuses a changed live buffer, including a continue-to-end request', async () => {
    const code = 'extrude(5);\nbreakpoint();\nfillet(2);';
    for (const target of [before(code, 'fillet'), null]) {
      const spec = TimelineBreakpoint.capture(code, target);
      const changed = code.replace('5', '10');
      const result = await TimelineBreakpoint.apply(changed, spec);
      expect(result.error).toContain('file changed');
      expect(result.newCode).toBe(changed);
    }
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

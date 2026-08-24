import { describe, it, expect } from 'vitest';
import { MoveToPart, type MoveToPartSpec } from '../src/move-to-part.ts';
import { applyFeatureEdit } from '../src/apply-feature-edit.ts';

/** Build a spec the way the route does: capture drift guards from `code`. */
async function moveSpec(code: string, lines: number[], partLine: number): Promise<MoveToPartSpec> {
  const captured = await MoveToPart.captureStatements(code, lines);
  if ('error' in captured) {
    throw new Error(captured.error);
  }
  return { statements: captured.statements, part: { line: partLine, column: 11 } };
}

function src(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

describe('MoveToPart.apply — splice', () => {
  it('moves an unbound sketch/extrude pair into a part below them', async () => {
    const code = src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
      `const p1 = part('Body', () => {`,
      `  sketch('xy', () => { rect(10, 10) })`,
      `  extrude(5)`,
      `})`,
    );
    const result = await MoveToPart.apply(code, await moveSpec(code, [3, 4], 6));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `const p1 = part('Body', () => {`,
      `  sketch('xy', () => { rect(10, 10) })`,
      `  extrude(5)`,
      `  sketch('xy', () => { rect(100, 50) })`,
      `  extrude(30)`,
      `})`,
    ));
  });

  it('moves statements up into a part above them', async () => {
    const code = src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `const p1 = part('Body', () => {`,
      `  sketch('xy', () => { rect(10, 10) })`,
      `  extrude(5)`,
      `})`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
    );
    const result = await MoveToPart.apply(code, await moveSpec(code, [8, 9], 3));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `const p1 = part('Body', () => {`,
      `  sketch('xy', () => { rect(10, 10) })`,
      `  extrude(5)`,
      `  sketch('xy', () => { rect(100, 50) })`,
      `  extrude(30)`,
      `})`,
    ));
  });

  it('opens an empty single-line body', async () => {
    const code = src(
      `import { sketch, rect, part } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const result = await MoveToPart.apply(code, await moveSpec(code, [3], 5));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { sketch, rect, part } from 'fluidcad/core'`,
      ``,
      `const p1 = part('Body', () => {`,
      `  sketch('xy', () => { rect(100, 50) })`,
      `})`,
    ));
  });

  it('lands before a trailing return', async () => {
    const code = src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      ``,
      `const p1 = part('Body', () => {`,
      `  const s = sketch('xy', () => { rect(10, 10) })`,
      `  return extrude(5)`,
      `})`,
    );
    const result = await MoveToPart.apply(code, await moveSpec(code, [3], 5));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `const p1 = part('Body', () => {`,
      `  const s = sketch('xy', () => { rect(10, 10) })`,
      `  sketch('xy', () => { rect(100, 50) })`,
      `  return extrude(5)`,
      `})`,
    ));
  });

  it('lands before an active breakpoint', async () => {
    const code = src(
      `import { sketch, rect, extrude, part, breakpoint } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      ``,
      `const p1 = part('Body', () => {`,
      `  extrude(5)`,
      `  breakpoint();`,
      `})`,
    );
    const result = await MoveToPart.apply(code, await moveSpec(code, [3], 5));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { sketch, rect, extrude, part, breakpoint } from 'fluidcad/core'`,
      ``,
      `const p1 = part('Body', () => {`,
      `  extrude(5)`,
      `  sketch('xy', () => { rect(100, 50) })`,
      `  breakpoint();`,
      `})`,
    ));
  });

  it('re-indents a multi-line statement and keeps document order regardless of selection order', async () => {
    const code = src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `const profile = sketch('xy', () => {`,
      `  rect(100, 50)`,
      `})`,
      `const solid = extrude(profile, 30)`,
      ``,
      `const p1 = part('Body', () => {`,
      `  extrude(5)`,
      `})`,
    );
    const result = await MoveToPart.apply(code, await moveSpec(code, [6, 3], 8));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `const p1 = part('Body', () => {`,
      `  extrude(5)`,
      `  const profile = sketch('xy', () => {`,
      `    rect(100, 50)`,
      `  })`,
      `  const solid = extrude(profile, 30)`,
      `})`,
    ));
  });

  it('routes through applyFeatureEdit via the moveToPart spec field', async () => {
    const code = src(
      `import { sketch, rect, part } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const result = await applyFeatureEdit(code, {
      feature: 'sketch',
      filePath: '/ws/model.fluid.js',
      producers: [],
      parts: [],
      imports: [],
      moveToPart: await moveSpec(code, [3], 5),
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const p1 = part('Body', () => {\n  sketch('xy', () => { rect(100, 50) })\n})`);
  });
});

describe('MoveToPart — dependency analysis', () => {
  it('requires the unmoved sketch a moved extrude references', async () => {
    const code = src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `const profile = sketch('xy', () => { rect(100, 50) })`,
      `const solid = extrude(profile, 30)`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const analysis = await MoveToPart.analyze(code, await moveSpec(code, [4], 6));
    expect(analysis.ok).toBe(false);
    if (analysis.ok === false) {
      expect(analysis.needs).toEqual([{ name: 'profile', line: 3 }]);
      expect(analysis.reason).toContain(`'profile' (line 3)`);
    }
    const applied = await MoveToPart.apply(code, await moveSpec(code, [4], 6));
    expect(applied.error).toContain(`'profile' (line 3)`);
    expect(applied.newCode).toBe(code);
  });

  it('requires the top-level consumer of a moved binding to come along', async () => {
    const code = src(
      `import { sketch, rect, extrude, fillet, part } from 'fluidcad/core'`,
      ``,
      `const profile = sketch('xy', () => { rect(100, 50) })`,
      `const base = extrude(profile, 30)`,
      `fillet(base.endEdges(), 3)`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const analysis = await MoveToPart.analyze(code, await moveSpec(code, [3, 4], 7));
    expect(analysis.ok).toBe(false);
    if (analysis.ok === false) {
      expect(analysis.needs).toEqual([{ name: 'fillet', line: 5 }]);
    }
    const closed = await MoveToPart.apply(code, await moveSpec(code, [3, 4, 5], 7));
    expect(closed.error).toBeUndefined();
    expect(closed.newCode).toBe(src(
      `import { sketch, rect, extrude, fillet, part } from 'fluidcad/core'`,
      ``,
      `const p1 = part('Body', () => {`,
      `  const profile = sketch('xy', () => { rect(100, 50) })`,
      `  const base = extrude(profile, 30)`,
      `  fillet(base.endEdges(), 3)`,
      `})`,
    ));
  });

  it('computes the transitive closure in one pass', async () => {
    const code = src(
      `import { sketch, rect, extrude, fillet, param, part } from 'fluidcad/core'`,
      ``,
      `const w = param('Width', 100)`,
      `const profile = sketch('xy', () => { rect(w, 50) })`,
      `const base = extrude(profile, 30)`,
      `const top = fillet(base.endEdges(), 3)`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const analysis = await MoveToPart.analyze(code, await moveSpec(code, [6], 8));
    expect(analysis.ok).toBe(false);
    if (analysis.ok === false) {
      const lines = analysis.needs!.map((n) => n.line).sort((a, b) => a - b);
      expect(lines).toEqual([4, 5]);
      // `w` is a param declaration — a value the moved code reaches through
      // the module closure, so it must NOT be dragged along.
      expect(analysis.needs!.some((n) => n.name === 'w')).toBe(false);
    }
  });

  it('pairs an implicit sketch consumer with its producer, in both directions', async () => {
    const code = src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const movedConsumer = await MoveToPart.analyze(code, await moveSpec(code, [4], 6));
    expect(movedConsumer.ok).toBe(false);
    if (movedConsumer.ok === false) {
      expect(movedConsumer.needs).toEqual([{ name: 'sketch', line: 3 }]);
    }
    const movedProducer = await MoveToPart.analyze(code, await moveSpec(code, [3], 6));
    expect(movedProducer.ok).toBe(false);
    if (movedProducer.ok === false) {
      expect(movedProducer.needs).toEqual([{ name: 'extrude', line: 4 }]);
    }
  });

  it('refuses when the moved binding is used inside another part', async () => {
    const code = src(
      `import { sketch, rect, extrude, part } from 'fluidcad/core'`,
      ``,
      `const profile = sketch('xy', () => { rect(100, 50) })`,
      ``,
      `const p2 = part('Other', () => {`,
      `  extrude(profile, 10)`,
      `})`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const analysis = await MoveToPart.analyze(code, await moveSpec(code, [3], 9));
    expect(analysis.ok).toBe(false);
    if (analysis.ok === false) {
      expect(analysis.reason).toContain(`'profile' is still used at line 6`);
      expect(analysis.needs).toBeUndefined();
    }
  });

  it('allows cross-part references from the moved statements', async () => {
    const code = src(
      `import { sketch, rect, part } from 'fluidcad/core'`,
      ``,
      `const p2 = part('Other', () => {`,
      `  rect(10, 10)`,
      `})`,
      ``,
      `sketch(p2.features.top, () => { rect(5, 5) })`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const analysis = await MoveToPart.analyze(code, await moveSpec(code, [7], 9));
    expect(analysis.ok).toBe(true);
  });
});

describe('MoveToPart — refusals and guards', () => {
  it('refuses a drifted statement', async () => {
    const code = src(
      `import { sketch, rect, part } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const spec = await moveSpec(code, [3], 5);
    const drifted = code.replace('rect(100, 50)', 'rect(120, 50)');
    const result = await MoveToPart.apply(drifted, spec);
    expect(result.error).toContain('changed since the timeline rendered');
    expect(result.newCode).toBe(drifted);
  });

  it('refuses to nest a part inside a part', async () => {
    const code = src(
      `import { sketch, rect, part } from 'fluidcad/core'`,
      ``,
      `const p2 = part('Other', () => { rect(10, 10) })`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const analysis = await MoveToPart.analyze(code, await moveSpec(code, [3], 5));
    expect(analysis.ok).toBe(false);
    if (analysis.ok === false) {
      expect(analysis.reason).toContain('parts cannot nest inside parts');
    }
  });

  it('refuses moving a part into itself', async () => {
    const code = src(
      `import { rect, part } from 'fluidcad/core'`,
      ``,
      `const p1 = part('Body', () => { rect(10, 10) })`,
    );
    const analysis = await MoveToPart.analyze(code, await moveSpec(code, [3], 3));
    expect(analysis.ok).toBe(false);
    if (analysis.ok === false) {
      expect(analysis.reason).toContain('cannot be moved into itself');
    }
  });

  it('treats members already inside the target as a no-op and refuses an empty move', async () => {
    const code = src(
      `import { sketch, rect, part } from 'fluidcad/core'`,
      ``,
      `const p1 = part('Body', () => {`,
      `  sketch('xy', () => { rect(10, 10) })`,
      `})`,
    );
    const analysis = await MoveToPart.analyze(code, await moveSpec(code, [4], 3));
    expect(analysis.ok).toBe(false);
    if (analysis.ok === false) {
      expect(analysis.reason).toContain('already inside that part');
    }
  });

  it('refuses statements from other scopes', async () => {
    const code = src(
      `import { extrude, part } from 'fluidcad/core'`,
      ``,
      `function helper() {`,
      `  extrude(10)`,
      `}`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const analysis = await MoveToPart.analyze(code, await moveSpec(code, [4], 7));
    expect(analysis.ok).toBe(false);
    if (analysis.ok === false) {
      expect(analysis.reason).toContain('only top-level features can move into a part');
    }
  });

  it('refuses a target line that holds no part()', async () => {
    const code = src(
      `import { sketch, rect } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `sketch('xy', () => { rect(10, 10) })`,
    );
    const analysis = await MoveToPart.analyze(code, await moveSpec(code, [3], 4));
    expect(analysis.ok).toBe(false);
    if (analysis.ok === false) {
      expect(analysis.reason).toContain('no part() call found at line 4');
    }
  });

  it('dedupes rows that share one statement', async () => {
    const code = src(
      `import { sketch, rect, part } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      ``,
      `const p1 = part('Body', () => {})`,
    );
    const captured = await MoveToPart.captureStatements(code, [3, 3]);
    expect('error' in captured).toBe(false);
    if (!('error' in captured)) {
      expect(captured.statements).toHaveLength(1);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { applyInstancePoseEdit } from '../src/insert-chain-edit.ts';

// The assembly gizmo's pose write-back: canonicalize an insert() chain's
// transform calls to `.rotate('x',…).rotate('y',…).rotate('z',…).translate(…)`
// (Q = Rz·Ry·Rx under the kernel's pre-multiply; translate-last pins the
// position exactly). Translate-only commits never touch .rotate() calls.
describe('applyInstancePoseEdit', () => {
  describe('rotation commits', () => {
    it('appends the canonical tail to a bare insert, omitting identity axes', async () => {
      const code = `insert(p);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [1, 2, 3], rotateXYZ: [30, 0, 45],
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toBe(`insert(p).rotate('x', 30).rotate('z', 45).translate(1, 2, 3);\n`);
    });

    it('works on const-bound inserts (the insertPart-written form)', async () => {
      const code = `const box = insert(p);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [1, 2, 3], rotateXYZ: [30, 0, 45],
      });
      expect(result.newCode).toBe(`const box = insert(p).rotate('x', 30).rotate('z', 45).translate(1, 2, 3);\n`);
    });

    it('updates a pure-Z rotation as a single clean call', async () => {
      const code = `insert(p).rotate('z', 45);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [0, 0, 60],
      });
      expect(result.newCode).toBe(`insert(p).rotate('z', 60);\n`);
    });

    it('moves an existing translate to the tail when a rotation is added', async () => {
      const code = `insert(p).translate(1, 2, 3);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [1, 2, 3], rotateXYZ: [0, 0, 90],
      });
      expect(result.newCode).toBe(`insert(p).rotate('z', 90).translate(1, 2, 3);\n`);
    });

    it('collapses a multi-rotate chain to its canonical decomposition', async () => {
      // Rz(-90)·Rx(15)·Rz(90) conjugates the X rotation onto -Y: Ry(-15).
      const code = `insert(p).rotate('z', 90).rotate('x', 15).rotate('z', -90);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [0, -15, 0],
      });
      expect(result.newCode).toBe(`insert(p).rotate('y', -15);\n`);
    });

    it('normalizes rotate-after-translate chains to the canonical order', async () => {
      // .translate(5,0,0).rotate('z',90) leaves the body at (0,5,0); the same
      // pose re-encodes as rotate-then-translate with the true position.
      const code = `insert(p).translate(5, 0, 0).rotate('z', 90);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 5, 0], rotateXYZ: [0, 0, 90],
      });
      expect(result.newCode).toBe(`insert(p).rotate('z', 90).translate(0, 5, 0);\n`);
    });

    it('identity rotation strips rotate calls and keeps the translate', async () => {
      const code = `insert(p).rotate('z', 45).translate(1, 2, 3);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [1, 2, 3], rotateXYZ: [0, 0, 0],
      });
      expect(result.newCode).toBe(`insert(p).translate(1, 2, 3);\n`);
    });

    it('identity pose reduces to a bare insert', async () => {
      const code = `insert(p).rotate('z', 45).translate(1, 2, 3);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [0, 0, 0],
      });
      expect(result.newCode).toBe(`insert(p);\n`);
    });

    it('preserves .name() and .grounded() in place, tail appended after them', async () => {
      const code = `insert(p).rotate('z', 45).name('foo').grounded();\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [0, 0, 60],
      });
      expect(result.newCode).toBe(`insert(p).name('foo').grounded().rotate('z', 60);\n`);
    });

    it('refuses an identifier rotation axis, leaving the code unchanged', async () => {
      const code = `insert(p).rotate(myAxis, 45);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [0, 0, 60],
      });
      expect(result.newCode).toBe(code);
      expect(result.error).toContain(`isn't a plain ('x'|'y'|'z', angle) rotation`);
      expect(result.error).toContain('.rotate(myAxis, 45)');
    });

    it('refuses an uncovered expression angle (a drag would flatten it)', async () => {
      const code = `insert(p).rotate('z', angle);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [0, 0, 60],
      });
      expect(result.newCode).toBe(code);
      expect(result.error).toContain('has an expression angle');
      expect(result.error).toContain(`.rotate('z', angle)`);
    });

    it('refuses an Axis.* expression axis', async () => {
      const code = `insert(p).rotate(Axis.Z(), 45);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [0, 0, 60],
      });
      expect(result.newCode).toBe(code);
      expect(result.error).toContain(`isn't a plain ('x'|'y'|'z', angle) rotation`);
    });

    it('rounds angles to six decimals and drops sub-epsilon terms', async () => {
      const code = `insert(p);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [44.9999999999, 0, -0.00000001],
      });
      expect(result.newCode).toBe(`insert(p).rotate('x', 45);\n`);
    });

    it('is idempotent: re-applying the committed pose is byte-identical', async () => {
      const spec = { sourceLine: 1, position: [1, 2, 3] as [number, number, number], rotateXYZ: [30, 0, 45] as [number, number, number] };
      const first = await applyInstancePoseEdit(`insert(p);\n`, spec);
      const second = await applyInstancePoseEdit(first.newCode, spec);
      expect(second.newCode).toBe(first.newCode);
    });
  });

  describe('translate-only commits (rotateXYZ: null)', () => {
    it('replaces translate args in place when no rotate follows it', async () => {
      const code = `insert(p).rotate(myAxis, 30).translate(1, 2, 3);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [4, 5, 6], rotateXYZ: null,
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toBe(`insert(p).rotate(myAxis, 30).translate(4, 5, 6);\n`);
    });

    it('moves the translate to the tail when an opaque rotate follows it', async () => {
      const code = `insert(p).translate(1, 2, 3).rotate(myAxis, 30);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [4, 5, 6], rotateXYZ: null,
      });
      expect(result.newCode).toBe(`insert(p).rotate(myAxis, 30).translate(4, 5, 6);\n`);
    });

    it('normalizes a parseable rotate-after-translate chain the same way', async () => {
      const code = `insert(p).translate(1, 2, 3).rotate('z', 45);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [9, 9, 9], rotateXYZ: null,
      });
      expect(result.newCode).toBe(`insert(p).rotate('z', 45).translate(9, 9, 9);\n`);
    });

    it('writes an explicit .translate(0, 0, 0) when an opaque rotate exists', async () => {
      // The opaque axis may not pass through the origin, so the orbit can
      // leave it — a bare chain would not pin the position.
      const code = `insert(p).translate(1, 2, 3).rotate(myAxis, 30);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: null,
      });
      expect(result.newCode).toBe(`insert(p).rotate(myAxis, 30).translate(0, 0, 0);\n`);
    });

    it('strips the translate at origin when all rotates are world-axis', async () => {
      const code = `insert(p).rotate('z', 45).translate(1, 2, 3);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: null,
      });
      expect(result.newCode).toBe(`insert(p).rotate('z', 45);\n`);
    });

    it('collapses multiple .translate() calls into one tail call', async () => {
      const code = `insert(p).translate(1, 0, 0).translate(2, 0, 0);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [5, 5, 5], rotateXYZ: null,
      });
      expect(result.newCode).toBe(`insert(p).translate(5, 5, 5);\n`);
    });

    it('leaves parseable rotates untouched on a pure move', async () => {
      const code = `insert(p).rotate('z', 45).translate(1, 2, 3);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [9, 9, 9], rotateXYZ: null,
      });
      expect(result.newCode).toBe(`insert(p).rotate('z', 45).translate(9, 9, 9);\n`);
    });
  });

  describe('translate expression overrides (translateExprs)', () => {
    it('splices the typed expression into its axis, numerics elsewhere', async () => {
      const code = `insert(p).translate(1, 2, 3);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [42, 2, 3], rotateXYZ: null,
        translateExprs: ['myVar', null, null],
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toBe(`insert(p).translate(myVar, 2, 3);\n`);
    });

    it('echoed text keeps untouched axes exactly as written', async () => {
      const code = `insert(p).translate(w, h, 5);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [30, 20, 12], rotateXYZ: null,
        translateExprs: ['w', 'h', null],
      });
      expect(result.newCode).toBe(`insert(p).translate(w, h, 12);\n`);
    });

    it('appends a translate carrying the expression to a bare chain', async () => {
      const code = `insert(p);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [42, 0, 0], rotateXYZ: null,
        translateExprs: ['spacing', null, null],
      });
      expect(result.newCode).toBe(`insert(p).translate(spacing, 0, 0);\n`);
    });

    it('writes the translate at the numeric origin when an expression rides it', async () => {
      // `.translate(zeroVar, 0, 0)` with zeroVar currently 0 still binds the
      // axis — the origin fast-path must not strip it.
      const code = `insert(p).translate(1, 0, 0);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: null,
        translateExprs: ['zeroVar', null, null],
      });
      expect(result.newCode).toBe(`insert(p).translate(zeroVar, 0, 0);\n`);
    });

    it('threads expressions through the rotate-after-translate rebuild', async () => {
      const code = `insert(p).translate(1, 2, 3).rotate('z', 45);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [9, 9, 9], rotateXYZ: null,
        translateExprs: ['myVar', null, null],
      });
      expect(result.newCode).toBe(`insert(p).rotate('z', 45).translate(myVar, 9, 9);\n`);
    });

    it('rotation commits carry echoed texts into the rebuilt tail', async () => {
      const code = `insert(p).rotate('z', 45).translate(w, h, 5);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [30, 20, 5], rotateXYZ: [0, 0, 90],
        translateExprs: ['w', 'h', '5'],
      });
      expect(result.newCode).toBe(`insert(p).rotate('z', 90).translate(w, h, 5);\n`);
    });
  });

  describe('rotate expression overrides (rotateExprs)', () => {
    it('writes the typed expression into its axis slot', async () => {
      const code = `insert(p).rotate('z', 45);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [0, 0, 60],
        rotateExprs: [null, null, 'spin'],
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toBe(`insert(p).rotate('z', spin);\n`);
    });

    it('echoed angle text carries an expression axis through another axis change', async () => {
      const code = `insert(p).rotate('x', tilt).rotate('z', 45).translate(1, 2, 3);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [1, 2, 3], rotateXYZ: [15, 0, 90],
        rotateExprs: ['tilt', null, null],
        translateExprs: ['1', '2', '3'],
      });
      expect(result.error).toBeUndefined();
      expect(result.newCode).toBe(`insert(p).rotate('x', tilt).rotate('z', 90).translate(1, 2, 3);\n`);
    });

    it('inserts a typed axis at its canonical slot among existing rotates', async () => {
      const code = `insert(p).rotate('x', 30);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [30, 20, 0],
        rotateExprs: ['30', 'lift', null],
      });
      expect(result.newCode).toBe(`insert(p).rotate('x', 30).rotate('y', lift);\n`);
    });

    it('writes an expression axis even at numeric identity', async () => {
      const code = `insert(p);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [0, 0, 0],
        rotateExprs: [null, null, 'spin'],
      });
      expect(result.newCode).toBe(`insert(p).rotate('z', spin);\n`);
    });

    it('refuses coverage on a non-canonically ordered chain', async () => {
      // z before x: putting the same texts back in canonical slots would
      // change the composed orientation.
      const code = `insert(p).rotate('z', spin).rotate('x', 30);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [0, 0, 0], rotateXYZ: [30, 0, 60],
        rotateExprs: [null, null, 'spin'],
      });
      expect(result.newCode).toBe(code);
      expect(result.error).toContain('has an expression angle');
    });
  });

  describe('errors', () => {
    it('reports a miss instead of silently no-oping', async () => {
      const code = `const x = 1;\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [1, 2, 3], rotateXYZ: null,
      });
      expect(result.newCode).toBe(code);
      expect(result.error).toContain('no statement starts on line 1');
    });

    it('reports a non-insert chain', async () => {
      const code = `foo(p).rotate('z', 1);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [1, 2, 3], rotateXYZ: null,
      });
      expect(result.newCode).toBe(code);
      expect(result.error).toContain(`isn't an insert() chain`);
    });

    it('reports a multi-line chain whose insert() is not on the source line', async () => {
      const code = `const a =\n  insert(p);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [1, 2, 3], rotateXYZ: null,
      });
      expect(result.newCode).toBe(code);
      expect(result.error).toBeTruthy();
    });

    it('rejects non-finite numbers', async () => {
      const code = `insert(p);\n`;
      const result = await applyInstancePoseEdit(code, {
        sourceLine: 1, position: [Number.NaN, 0, 0], rotateXYZ: null,
      });
      expect(result.newCode).toBe(code);
      expect(result.error).toContain('non-finite');
    });
  });
});

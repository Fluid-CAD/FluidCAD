/**
 * The host contract's source transforms, as a table.
 *
 * Every one of them has the same shape — read the buffer, POST it to the
 * matching `/api/code/<transform>` with a couple of arguments, apply the
 * `newCode` that comes back — so what actually differs is captured here as
 * data rather than as twenty-four near-identical functions
 * (`feedback_reusable_helpers`). The parsing, the AST rewrite and the
 * preflight all live in the server; the host is an applier, not an editor
 * integration (`docs/desktop/00-architecture.md`).
 *
 * Ported from `extension/vscode/src/{code-edits,code-api}.ts`, which stays the
 * IPC host's copy until Phase 3.
 */

/** Which file an edit lands in. */
export type EditTarget =
  /** The model the scene is rendered from — the file every sketch edit means. */
  | 'current'
  /** `msg.filePath`: a feature may live in an imported file, not the active one. */
  | 'path';

export type TransformSpec = {
  /** The `/api/code/<endpoint>` route. */
  endpoint: string;
  target: EditTarget;
  /** Everything the route wants besides `code`. */
  body(msg: any): Record<string, unknown>;
};

/** Sketch-scoped edits: the row comes from `sourceLocation`. */
function atSourceLine(msg: any): Record<string, unknown> {
  return { sourceLine: msg.sourceLocation.line };
}

export const TRANSFORMS: Record<string, TransformSpec> = {
  'insert-point': {
    endpoint: 'insert-point',
    target: 'current',
    body: (msg) => ({ ...atSourceLine(msg), point: msg.point }),
  },
  'remove-point': {
    endpoint: 'remove-point',
    target: 'current',
    body: (msg) => ({ ...atSourceLine(msg), point: msg.point }),
  },
  'add-pick': { endpoint: 'add-pick', target: 'current', body: atSourceLine },
  'remove-pick': { endpoint: 'remove-pick', target: 'current', body: atSourceLine },
  'add-guide': { endpoint: 'add-guide', target: 'current', body: atSourceLine },
  'remove-guide': { endpoint: 'remove-guide', target: 'current', body: atSourceLine },
  'set-pick-points': {
    endpoint: 'set-pick-points',
    target: 'current',
    body: (msg) => ({ ...atSourceLine(msg), points: msg.points }),
  },
  'set-trim-targets': {
    endpoint: 'set-trim-targets',
    target: 'current',
    body: (msg) => ({ ...atSourceLine(msg), args: msg.args }),
  },
  'insert-geometry': {
    endpoint: 'insert-geometry',
    target: 'current',
    body: (msg) => ({
      sketchSourceLine: msg.sketchSourceLocation.line,
      statement: msg.statement,
      newVariable: msg.newVariable ?? null,
    }),
  },
  'update-position': {
    endpoint: 'update-position',
    target: 'current',
    body: (msg) => ({
      ...atSourceLine(msg),
      newPosition: msg.newPosition,
      pointIndex: msg.pointIndex ?? 0,
      oldPosition: msg.oldPosition ?? null,
    }),
  },
  'update-point-expression': {
    endpoint: 'update-point-expression',
    target: 'current',
    body: (msg) => ({
      ...atSourceLine(msg),
      xExpr: msg.xExpr,
      yExpr: msg.yExpr,
      sketchSourceLine: msg.sketchSourceLine ?? null,
      newVariable: msg.newVariable ?? null,
      pointIndex: msg.pointIndex ?? 0,
      oldPosition: msg.oldPosition ?? null,
    }),
  },
  'set-line-position': {
    endpoint: 'set-line-position',
    target: 'current',
    body: (msg) => ({ ...atSourceLine(msg), newStart: msg.newStart, newEnd: msg.newEnd }),
  },
  'set-chain-positions': {
    endpoint: 'set-chain-positions',
    target: 'current',
    body: (msg) => ({ ...atSourceLine(msg), updates: msg.updates }),
  },
  'set-rect-dimensions': {
    endpoint: 'set-rect-dimensions',
    target: 'current',
    body: (msg) => ({
      ...atSourceLine(msg),
      startPoint: msg.startPoint,
      width: msg.width,
      height: msg.height,
      oldStartPoint: msg.oldStartPoint ?? null,
    }),
  },
  'update-dimension': {
    endpoint: 'update-dimension',
    target: 'current',
    body: (msg) => ({ ...atSourceLine(msg), newValue: msg.newValue }),
  },
  'update-dimension-expression': {
    endpoint: 'update-dimension-expression',
    target: 'current',
    body: (msg) => ({
      ...atSourceLine(msg),
      expression: msg.expression,
      sketchSourceLine: msg.sketchSourceLine ?? null,
      newVariable: msg.newVariable ?? null,
      dimensionOffset: msg.dimensionOffset ?? 0,
      dimensionCall: msg.dimensionCall ?? null,
      dimensionInsert: msg.dimensionInsert === true,
      dimensionPoint: msg.dimensionPoint ?? null,
    }),
  },

  // Timeline edits name their own file: a feature can live in an imported
  // model rather than the one the scene is currently rendered from.
  'remove-feature': {
    endpoint: 'remove-statement',
    target: 'path',
    body: (msg) => ({ sourceLine: msg.line }),
  },
  'rename-feature': {
    endpoint: 'set-feature-name',
    target: 'path',
    body: (msg) => ({ sourceLine: msg.line, name: msg.name }),
  },
  'insert-load': {
    endpoint: 'insert-load',
    target: 'path',
    body: (msg) => ({ fileName: msg.fileName }),
  },

  // Breakpoints. `referenceRow` is **0-based** while `sourceLocation.line` is
  // 1-based; passing the raw line lands the breakpoint one statement too late.
  'add-breakpoint': {
    endpoint: 'add-breakpoint',
    target: 'path',
    body: (msg) => ({ referenceRow: Math.max(0, msg.line - 1) }),
  },
  'clear-breakpoints': {
    endpoint: 'clear-breakpoints',
    target: 'current',
    body: () => ({}),
  },
};

export type CodeEditResult = {
  newCode: string;
  /** Breakpoint routes report where the marker actually landed. */
  breakpointLine?: number | null;
  /** `apply-feature` refuses in-band rather than with a status code. */
  error?: string;
};

/** POST a transform and return its result, or null when the request failed. */
export async function postCodeEdit(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<CodeEditResult | null> {
  try {
    const res = await fetch(`/api/code/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`FluidCAD: /api/code/${endpoint} answered ${res.status}`);
      return null;
    }
    return (await res.json()) as CodeEditResult;
  } catch (err) {
    console.warn(`FluidCAD: /api/code/${endpoint} failed:`, err);
    return null;
  }
}

// Stable identities for the statements of a sketch — what a region key is
// written in terms of.
//
// The source already carries sparse, human-readable ids for sketch entities:
// their binding names (`const b = line(…)`). The kernel never sees variable
// names at run time, but it does hold two things that recover them: the
// sketch callback's own text (`Function.prototype.toString`) and, for every
// statement, the line and column its stack trace captured. A statement's line
// relative to the sketch's own line addresses a line of the callback text,
// and the column lands on the callee (`line`, `circle`, …) — the binding, if
// any, is the `const NAME =` just before it.
//
// A statement without a binding is `<callee>#<n>`, the n-th statement of that
// callee in the sketch. That ordinal shifts when an EARLIER statement of the
// same callee is deleted — the reason bound names come first. A call site a
// loop runs several times binds one name for several statements: those are
// told apart by their run, `l[0]`, `l[1]`.

import { SceneObject, SourceLocation } from "../../../common/scene-object.js";

/** Kernel type → the callee the statement was written with. */
const CALLEE_BY_TYPE: Record<string, string> = {
  line: 'line',
  arc: 'arc',
  circle: 'circle',
  point: 'point',
  ellipse: 'ellipse',
  bezier: 'bezier',
  rect: 'rect',
  text: 'text',
  projection: 'project',
  intersect: 'intersect',
  offset: 'offset',
  fillet2d: 'fillet',
  'copy-linear': 'copy',
  'copy-circular': 'copy',
  mirror: 'mirror',
  rotate: 'rotate',
};

export function statementCallee(obj: SceneObject): string {
  const type = obj.getType();
  return CALLEE_BY_TYPE[type] ?? type.replace(/[^\w$]/g, '_');
}

export type StatementKeySources = {
  /** The sketch statement's own location — the callback text starts on its line. */
  sketchLocation: SourceLocation | null;
  /** `sketcher.toString()` — verbatim, newlines intact. */
  callbackSource: string | null;
};

/** The words that may introduce a binding before a call. */
const BINDING_BEFORE_CALL = /(?:^|[;{}]|\b(?:const|let|var)\s+|,)\s*([A-Za-z_$][\w$]*)\s*=\s*$/;

/**
 * The text of a function as the source wrote it. The live loader runs the
 * file through Vite's SSR transform, which rewrites every imported callee in
 * place — `line(` becomes `(0,__vite_ssr_import_0__.line)(` — and leaves
 * every other character where it was; the stack traces are mapped back to
 * the file. Undoing that rewrite gives back the file's text, column for
 * column.
 */
export function normalizeCallbackSource(source: string): string {
  return source
    .replace(/\(0,\s*__vite_ssr_import_\d+__\.([A-Za-z_$][\w$]*)\)/g, '$1')
    .replace(/\b__vite_ssr_import_\d+__\.([A-Za-z_$][\w$]*)/g, '$1');
}

export class SketchStatementKeys {
  private readonly keys = new Map<SceneObject, string>();
  private readonly order = new Map<SceneObject, number>();
  private readonly byKey = new Map<string, SceneObject>();
  /** How many lines the callback text starts below the sketch statement's
   * line — 0 unless the callback opens on a later line. Learned from the
   * first statement whose callee is found where its column says. */
  private lineShift: number | null = null;

  private readonly sources: StatementKeySources;

  constructor(statements: SceneObject[], sources: StatementKeySources) {
    this.sources = {
      sketchLocation: sources.sketchLocation,
      callbackSource: sources.callbackSource === null ? null : normalizeCallbackSource(sources.callbackSource),
    };
    this.lineShift = this.detectLineShift(statements);
    const bindings = new Map<SceneObject, string | null>();
    for (const statement of statements) {
      bindings.set(statement, this.bindingNameOf(statement));
    }

    // A call site that ran more than once (a loop) shares one binding among
    // its statements — number the runs.
    const callSiteCounts = new Map<string, number>();
    for (const statement of statements) {
      const site = callSiteOf(statement);
      if (site) {
        callSiteCounts.set(site, (callSiteCounts.get(site) ?? 0) + 1);
      }
    }
    const callSiteRuns = new Map<string, number>();
    const calleeCounts = new Map<string, number>();

    statements.forEach((statement, index) => {
      this.order.set(statement, index);
      const callee = statementCallee(statement);
      const ordinal = (calleeCounts.get(callee) ?? 0) + 1;
      calleeCounts.set(callee, ordinal);

      const name = bindings.get(statement);
      let key: string;
      if (name) {
        const site = callSiteOf(statement)!;
        if ((callSiteCounts.get(site) ?? 0) > 1) {
          const run = callSiteRuns.get(site) ?? 0;
          callSiteRuns.set(site, run + 1);
          key = `${name}[${run}]`;
        } else {
          key = name;
        }
      } else {
        key = `${callee}#${ordinal}`;
      }
      // Two statements can only collide when the source binds one name twice
      // in the callback (shadowing) — the later one falls back to its ordinal
      // so every key still names exactly one statement.
      if (this.byKey.has(key)) {
        key = `${callee}#${ordinal}`;
      }
      this.keys.set(statement, key);
      this.byKey.set(key, statement);
    });
  }

  keyOf(statement: SceneObject): string | null {
    return this.keys.get(statement) ?? null;
  }

  /** Position of the statement among the sketch's statements — the order
   * regions are canonically sorted by. */
  orderOf(statement: SceneObject): number {
    return this.order.get(statement) ?? Number.MAX_SAFE_INTEGER;
  }

  statementOf(key: string): SceneObject | null {
    return this.byKey.get(key) ?? null;
  }

  /**
   * How far below the sketch statement's line the callback text starts.
   * Usually 0 (`sketch("xy", () => {`); a callback written on a later line
   * shifts every row. The shift is the one under which the most statements
   * find their callee where their column says — a single statement can
   * verify against a neighbouring line by coincidence, a sketch cannot.
   */
  private detectLineShift(statements: SceneObject[]): number | null {
    const { sketchLocation, callbackSource } = this.sources;
    if (!sketchLocation || !callbackSource) {
      return null;
    }
    const lines = callbackSource.split('\n');
    let bestShift = 0;
    let bestCount = -1;
    for (let shift = 0; shift < 4; shift++) {
      let count = 0;
      for (const statement of statements) {
        const location = statement.getSourceLocation();
        if (!location || location.filePath !== sketchLocation.filePath) {
          continue;
        }
        const row = location.line - sketchLocation.line - shift;
        if (row < 0 || row >= lines.length) {
          continue;
        }
        if (bindingOnLine(lines[row], location.column, statementCallee(statement), row === 0) !== undefined) {
          count++;
        }
      }
      if (count > bestCount) {
        bestCount = count;
        bestShift = shift;
      }
    }
    return bestShift;
  }

  private bindingNameOf(statement: SceneObject): string | null {
    const { sketchLocation, callbackSource } = this.sources;
    const location = statement.getSourceLocation();
    if (!sketchLocation || !callbackSource || !location || this.lineShift === null) {
      return null;
    }
    if (location.filePath !== sketchLocation.filePath || location.line < sketchLocation.line) {
      return null;
    }
    const lines = callbackSource.split('\n');
    const row = location.line - sketchLocation.line - this.lineShift;
    if (row < 0 || row >= lines.length) {
      return null;
    }
    const found = bindingOnLine(lines[row], location.column, statementCallee(statement), row === 0);
    return found ?? null;
  }
}

function callSiteOf(statement: SceneObject): string | null {
  const location = statement.getSourceLocation();
  return location ? `${location.filePath}:${location.line}:${location.column}` : null;
}

/**
 * The binding written before the `callee(` at `column` (1-based) on this
 * line: a name, null when the call is not bound, undefined when no such call
 * sits at that column. Which column a stack trace reports for a call
 * differs between V8's own frames (the callee's first character) and
 * Node's source-map-aware frames (the opening parenthesis), so any column
 * from the callee's start through its `(` counts. The callback's first line
 * starts mid-way through the file's line, so its columns don't line up:
 * there the call is located by text instead, and only when the line holds
 * exactly one call of the callee.
 */
function bindingOnLine(line: string, column: number, callee: string, firstLine: boolean): string | null | undefined {
  const callPattern = new RegExp(`\\b${callee}\\s*\\(`, 'g');
  const calls: { start: number; paren: number }[] = [];
  for (let m = callPattern.exec(line); m; m = callPattern.exec(line)) {
    calls.push({ start: m.index, paren: m.index + m[0].length - 1 });
  }

  let call: { start: number; paren: number } | undefined;
  if (firstLine) {
    if (calls.length !== 1) {
      return undefined;
    }
    call = calls[0];
  } else {
    const at = column - 1;
    call = calls.find(c => at >= c.start && at <= c.paren);
    if (!call) {
      return undefined;
    }
  }

  const before = line.slice(0, call.start);
  const match = BINDING_BEFORE_CALL.exec(before);
  return match ? match[1] : null;
}

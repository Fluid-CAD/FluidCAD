/**
 * P7 codemod: rewrite legacy imperative sketch statements to the solved
 * (constraint) model. See docs/sketch-rewrite/phase7.md.
 *
 * Usage:
 *   tsx scripts/modernize-sketch.ts [--mode=test|primitives] [--write] <files...>
 *
 * Conversion unit is a whole sketch() callback: it converts only when every
 * statement inside is understood, otherwise leaves the sketch untouched and
 * reports why. Mechanical tiers only — target forms, qualifiers, tArc/aLine/
 * tLine/connect/back/slot/polygon and non-static pen math are hand work.
 *
 * --mode=test       bare rect(w,h) becomes testRect(w,h) from
 *                   lib/tests/helpers/profiles.ts (lib/tests files only)
 * --mode=primitives rect(w,h) becomes 4 lines + full constraint set inline
 *                   (for website _examples and other non-test sources)
 */
import path from "node:path";
import { Project, SyntaxKind, Node, CallExpression, ArrowFunction, FunctionExpression, SourceFile } from "ts-morph";

type Pt = { x: number; y: number };
type Cursor = Pt | null; // null = statically unknown

const HARD_CALLEES = new Set([
  "tArc", "tLine", "aLine", "tCircle", "connect", "back", "pMove", "rMove",
  "slot", "polygon", "trim", "fuse", "subtract", "common", "split",
]);
// Statements that neither read nor move the pen — pass through verbatim.
const PASSTHROUGH_CALLEES = new Set([
  "coincident", "horizontal", "vertical", "parallel", "perpendicular",
  "tangent", "equal", "concentric", "collinear", "midpoint", "symmetric",
  "distance", "angle", "radius", "diameter", "fix",
  "point", "origin", "xAxis", "yAxis", "project", "intersect", "select",
  "guide", "mirror2d", "copy2d", "rotate2d", "fillet2d", "testRect",
]);
// Derived ops that survive P7: pass through, but conservatively lose the
// static pen (their legacy forms could touch it).
const DERIVED_CALLEES = new Set(["offset", "fillet", "mirror", "copy", "rotate"]);
const LEGACY_IMPORT_NAMES = new Set([
  "move", "hMove", "vMove", "pMove", "rMove", "back", "center",
  "hLine", "vLine", "tLine", "aLine", "tArc", "tCircle", "connect",
  "rect", "slot", "polygon",
]);

function fmt(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
}
function fmtPt(p: Pt): string {
  return `[${fmt(p.x)}, ${fmt(p.y)}]`;
}
function near(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
}

/** Static evaluation of simple numeric expressions (literals, unary +/-). */
function staticNum(node: Node | undefined): number | null {
  if (!node) return null;
  if (Node.isNumericLiteral(node)) return node.getLiteralValue();
  if (Node.isPrefixUnaryExpression(node)) {
    const v = staticNum(node.getOperand());
    if (v === null) return null;
    const op = node.getOperatorToken();
    if (op === SyntaxKind.MinusToken) return -v;
    if (op === SyntaxKind.PlusToken) return v;
    return null;
  }
  if (Node.isParenthesizedExpression(node)) return staticNum(node.getExpression());
  if (Node.isBinaryExpression(node)) {
    const l = staticNum(node.getLeft());
    const r = staticNum(node.getRight());
    if (l === null || r === null) return null;
    switch (node.getOperatorToken().getKind()) {
      case SyntaxKind.PlusToken: return l + r;
      case SyntaxKind.MinusToken: return l - r;
      case SyntaxKind.AsteriskToken: return l * r;
      case SyntaxKind.SlashToken: return r === 0 ? null : l / r;
      default: return null;
    }
  }
  return null;
}

function staticPt(node: Node | undefined): Pt | null {
  if (!node) return null;
  if (Node.isArrayLiteralExpression(node)) {
    const els = node.getElements();
    if (els.length !== 2) return null;
    const x = staticNum(els[0]);
    const y = staticNum(els[1]);
    if (x === null || y === null) return null;
    return { x, y };
  }
  return null;
}

/** Innermost call of a chain like rect(1,2).centered().name('x'). */
function rootCall(expr: Node): CallExpression | null {
  let node: Node = expr;
  // Unwrap casts/parens.
  while (Node.isAsExpression(node) || Node.isParenthesizedExpression(node)) {
    node = node.getExpression();
  }
  if (!Node.isCallExpression(node)) return null;
  let call: CallExpression = node;
  for (;;) {
    const callee = call.getExpression();
    if (Node.isIdentifier(callee)) return call;
    if (Node.isPropertyAccessExpression(callee)) {
      const inner = callee.getExpression();
      if (Node.isCallExpression(inner)) { call = inner; continue; }
      return null; // method call on an identifier (e.g. b.end()) — not a chain root
    }
    return null;
  }
}

/** Chain suffix text after the root call: ".centered().name('x')" etc. */
function chainSuffix(full: Node, root: CallExpression): string {
  let node: Node = full;
  while (Node.isAsExpression(node) || Node.isParenthesizedExpression(node)) {
    node = node.getExpression();
  }
  return node.getText().slice(root.getText().length);
}

/** Parse suffix into modifier call names, e.g. ["centered", "name"]. */
function suffixCalls(suffix: string): string[] {
  const names: string[] = [];
  const re = /\.([A-Za-z_$][\w$]*)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(suffix))) names.push(m[1]);
  return names;
}

interface EmittedSeg { name: string; end: () => string; start: () => string; }

class NameAlloc {
  private used: Set<string>;
  private i = 0;
  constructor(file: SourceFile) {
    this.used = new Set(file.getDescendantsOfKind(SyntaxKind.Identifier).map(id => id.getText()));
  }
  next(prefix = "sg"): string {
    for (;;) {
      this.i += 1;
      const n = `${prefix}${this.i}`;
      if (!this.used.has(n)) { this.used.add(n); return n; }
    }
  }
}

interface SketchResult {
  converted: boolean;
  reason?: string;
  usedTestRect?: boolean;
  usedNames?: Set<string>; // constraint/entity callees the new body needs imported
  newBody?: string[];
}

function convertCallback(
  body: Node[],
  names: NameAlloc,
  mode: "test" | "primitives",
  planeIsCanonical: boolean,
): SketchResult {
  const geometry: string[] = [];
  const constraints: string[] = [];
  const used = new Set<string>();
  let usedTestRect = false;
  // The legacy pen starts at the PLANE CENTER in local coordinates
  // (Sketch.getStartPoint = worldToLocal(planeCenter)) — that is [0,0] only
  // for canonical string planes ("xy"/"xz"/"yz"). On face/derived planes the
  // start is the face centroid, statically unknowable.
  const penOrigin: Cursor = planeIsCanonical ? { x: 0, y: 0 } : null;
  let cursor: Cursor = penOrigin ? { ...penOrigin } : null;
  let prevSeg: EmittedSeg | null = null; // last pen-chained segment
  let chainStart: { seg: EmittedSeg; pt: Pt } | null = null;
  let chainLen = 0;
  let sawLegacy = false;
  let lastEnd: Pt | null = null;

  const closeChainIfLoop = () => {
    if (chainStart && chainLen >= 3 && lastEnd && near(lastEnd, chainStart.pt) && prevSeg && prevSeg !== chainStart.seg) {
      used.add("coincident");
      constraints.push(`coincident(${prevSeg.name}.end(), ${chainStart.seg.name}.start());`);
    }
  };
  // Every pen re-anchor first gives a completed loop its closing coincident.
  const breakChain = () => { closeChainIfLoop(); prevSeg = null; chainStart = null; chainLen = 0; };

  const emitLine = (
    bindName: string | null, start: Pt, end: Pt, suffix: string,
    axis: "h" | "v" | null, chained: boolean,
  ) => {
    const name = bindName ?? names.next();
    used.add("line");
    geometry.push(`const ${name} = line(${fmtPt(start)}, ${fmtPt(end)})${suffix};`);
    const seg: EmittedSeg = { name, end: () => `${name}.end()`, start: () => `${name}.start()` };
    if (chained && prevSeg) {
      used.add("coincident");
      constraints.push(`coincident(${prevSeg.name}.end(), ${name}.start());`);
    }
    if (axis === "h") { used.add("horizontal"); constraints.push(`horizontal(${name});`); }
    if (axis === "v") { used.add("vertical"); constraints.push(`vertical(${name});`); }
    if (!chained || !chainStart) chainStart = { seg, pt: start };
    chainLen += 1;
    prevSeg = seg;
    lastEnd = end;
    cursor = { ...end };
  };

  const emitRect = (bindText: string | null, wText: string, hText: string, at: Pt, w: number | null, h: number | null) => {
    breakChain();
    if (mode === "test") {
      usedTestRect = true;
      const atArg = (at.x === 0 && at.y === 0) ? "" : `, { at: ${fmtPt(at)} }`;
      geometry.push(`${bindText ?? ""}testRect(${wText}, ${hText}${atArg});`);
    } else {
      if (w === null || h === null) throw new Error("primitives-mode rect needs static size");
      const p = (x: number, y: number) => fmtPt({ x, y });
      const b = names.next(); const r = names.next(); const t = names.next(); const l = names.next();
      for (const n of ["line", "coincident", "horizontal", "vertical", "fix", "distance"]) used.add(n);
      geometry.push(
        `const ${b} = line(${p(at.x, at.y)}, ${p(at.x + w, at.y)});`,
        `const ${r} = line(${p(at.x + w, at.y)}, ${p(at.x + w, at.y + h)});`,
        `const ${t} = line(${p(at.x + w, at.y + h)}, ${p(at.x, at.y + h)});`,
        `const ${l} = line(${p(at.x, at.y + h)}, ${p(at.x, at.y)});`,
      );
      constraints.push(
        `coincident(${b}.end(), ${r}.start());`,
        `coincident(${r}.end(), ${t}.start());`,
        `coincident(${t}.end(), ${l}.start());`,
        `coincident(${l}.end(), ${b}.start());`,
        `horizontal(${b});`, `vertical(${r});`, `horizontal(${t});`, `vertical(${l});`,
        `fix(${b}.start(), ${fmtPt(at)});`,
        `distance(${b}.start(), ${b}.end(), ${fmt(Math.abs(w))});`,
        `distance(${r}.start(), ${r}.end(), ${fmt(Math.abs(h))});`,
      );
    }
  };

  for (const stmt of body) {
    let bindName: string | null = null;
    let expr: Node | null = null;
    let returnLike = false;

    if (Node.isExpressionStatement(stmt)) {
      expr = stmt.getExpression();
    } else if (Node.isVariableStatement(stmt)) {
      const decls = stmt.getDeclarations();
      if (decls.length !== 1) return { converted: false, reason: "multi-declaration statement" };
      const init = decls[0].getInitializer();
      const nameNode = decls[0].getNameNode();
      if (!init || !Node.isIdentifier(nameNode)) return { converted: false, reason: "destructuring/uninitialized declaration" };
      bindName = nameNode.getText();
      expr = init;
    } else if (Node.isReturnStatement(stmt)) {
      // keep returns verbatim (they expose bindings) — but they must not
      // reference pen state, which they can't.
      geometry.push("__RETURN__" + stmt.getText());
      returnLike = true;
    } else {
      return { converted: false, reason: `unsupported statement kind ${stmt.getKindName()}` };
    }
    if (returnLike) continue;

    const root = rootCall(expr!);
    if (!root) return { converted: false, reason: `unrecognized expression: ${expr!.getText().slice(0, 60)}` };
    const callee = root.getExpression().getText();
    const suffix = chainSuffix(expr!, root);
    const mods = suffixCalls(suffix);
    const args = root.getArguments();

    if (HARD_CALLEES.has(callee)) return { converted: false, reason: `hard callee ${callee}()` };

    if (PASSTHROUGH_CALLEES.has(callee)) {
      // constraint / solved statement — verbatim, pen untouched
      constraints.push(stmt.getText());
      continue;
    }

    if (DERIVED_CALLEES.has(callee)) {
      breakChain();
      cursor = null;
      geometry.push(stmt.getText());
      continue;
    }

    switch (callee) {
      case "center": {
        if (args.length !== 0 || suffix) return { converted: false, reason: "center() with args/modifiers" };
        // center() returns the pen to the plane center — origin only on
        // canonical planes.
        cursor = penOrigin ? { ...penOrigin } : null;
        breakChain();
        break;
      }
      case "move": {
        if (suffix) return { converted: false, reason: "move() with modifiers" };
        if (args.length === 0) { cursor = penOrigin ? { ...penOrigin } : null; breakChain(); break; }
        if (args.length === 1) {
          const p = staticPt(args[0]);
          if (!p) return { converted: false, reason: "non-static move() target" };
          cursor = p; breakChain(); break;
        }
        const dx = staticNum(args[0]); const dy = staticNum(args[1]);
        if (dx === null || dy === null || !cursor) return { converted: false, reason: "non-static relative move()" };
        cursor = { x: cursor.x + dx, y: cursor.y + dy }; breakChain(); break;
      }
      case "hMove": case "vMove": {
        if (suffix) return { converted: false, reason: `${callee}() with modifiers` };
        const d = staticNum(args[0]);
        if (d === null || !cursor) return { converted: false, reason: `non-static ${callee}()` };
        cursor = callee === "hMove" ? { x: cursor.x + d, y: cursor.y } : { x: cursor.x, y: cursor.y + d };
        breakChain(); break;
      }
      case "hLine": case "vLine": {
        if (mods.some(m => m !== "name" && m !== "guide")) {
          return { converted: false, reason: `${callee}() modifier .${mods.join("/.")}()` };
        }
        let start: Pt | null = cursor; let dArg: Node | undefined = args[0]; let chained = true;
        if (args.length === 2) { start = staticPt(args[0]); dArg = args[1]; chained = false; }
        const d = staticNum(dArg);
        if (!start || d === null) return { converted: false, reason: `non-static ${callee}()` };
        const end = callee === "hLine" ? { x: start.x + d, y: start.y } : { x: start.x, y: start.y + d };
        if (!chained) breakChain();
        emitLine(bindName, start, end, suffix, callee === "hLine" ? "h" : "v", chained && prevSeg !== null);
        sawLegacy = true;
        break;
      }
      case "line": {
        if (mods.some(m => m !== "name" && m !== "guide")) {
          return { converted: false, reason: `line() modifier .${mods.join("/.")}()` };
        }
        if (args.length === 2) {
          const s = staticPt(args[0]); const e = staticPt(args[1]);
          if (s && e) {
            // explicit two-point line: breaks the pen chain in legacy? No —
            // legacy line(start,end) emitted a Move first, so it re-anchors.
            breakChain();
            emitLine(bindName, s, e, suffix, null, false);
          } else {
            // dynamic two-point solved-style line: keep verbatim, cursor unknown
            geometry.push(stmt.getText());
            cursor = null; breakChain();
          }
          break;
        }
        if (args.length === 1) {
          const e = staticPt(args[0]);
          if (!e || !cursor) return { converted: false, reason: "non-static chained line()" };
          emitLine(bindName, cursor, e, suffix, null, prevSeg !== null);
          sawLegacy = true;
          break;
        }
        return { converted: false, reason: `line() with ${args.length} args` };
      }
      case "arc": {
        // Only the solved 3-point form passes through; every legacy arc form
        // is pen/branch-dependent and stays hand work.
        if (args.length >= 3 && staticPt(args[0]) && staticPt(args[1]) && staticPt(args[2])) {
          breakChain();
          cursor = null;
          geometry.push(stmt.getText());
          break;
        }
        return { converted: false, reason: "legacy arc() form" };
      }
      case "circle": {
        if (mods.some(m => m !== "name" && m !== "guide")) {
          return { converted: false, reason: `circle() modifier .${mods.join("/.")}()` };
        }
        if (args.length === 2) {
          const c = staticPt(args[0]);
          geometry.push(stmt.getText());
          // legacy circle(center, d) moved the pen to center
          if (c) { cursor = c; } else { cursor = null; }
          breakChain();
          break;
        }
        if (!cursor) return { converted: false, reason: "circle() at unknown pen position" };
        const dText = args.length === 1 ? args[0].getText() : "40";
        if (args.length === 1 && staticNum(args[0]) === null && !Node.isIdentifier(args[0])) {
          return { converted: false, reason: "non-static circle() diameter" };
        }
        used.add("circle");
        const bind = bindName ? `const ${bindName} = ` : "";
        geometry.push(`${bind}circle(${fmtPt(cursor)}, ${dText})${suffix};`);
        sawLegacy = true;
        breakChain();
        break;
      }
      case "rect": {
        const extraMods = mods.filter(m => m !== "centered");
        if (extraMods.length > 0) return { converted: false, reason: `rect() modifier .${extraMods.join("/.")}()` };
        if (bindName && mode === "test") return { converted: false, reason: "rect() result is bound (testRect returns lines)" };
        // Normalize the four legacy arities to (startPt | pen, wNode, hNode):
        // rect(w) square, rect(w, h), rect(pt, w) square, rect(pt, w, h).
        let wNode = args[0]; let hNode = args[1] ?? args[0];
        let explicitStart: Pt | null = null;
        if (args.length >= 2 && staticPt(args[0])) {
          explicitStart = staticPt(args[0]);
          wNode = args[1]; hNode = args[2] ?? args[1];
        } else if (args.length > 2) {
          return { converted: false, reason: "rect() with 3 args and non-static start" };
        }
        if (args.length === 0) return { converted: false, reason: "rect() with 0 args" };
        if (explicitStart) cursor = explicitStart; // legacy form emits a Move first
        if (!cursor) return { converted: false, reason: "rect() at unknown pen position" };
        const w = staticNum(wNode); const h = staticNum(hNode);
        const centered = mods.includes("centered");
        let centerMode: true | "horizontal" | "vertical" | false = false;
        if (centered) {
          const m = /\.centered\(([^)]*)\)/.exec(suffix);
          const arg = (m?.[1] ?? "").trim();
          if (arg === "" || arg === "true") centerMode = true;
          else if (arg === "'horizontal'" || arg === '"horizontal"') centerMode = "horizontal";
          else if (arg === "'vertical'" || arg === '"vertical"') centerMode = "vertical";
          else return { converted: false, reason: `rect().centered(${arg}) not static` };
        }
        let at: Pt = { ...cursor };
        let endCursor: Pt = { x: cursor.x + (w ?? 0), y: cursor.y + (h ?? 0) };
        if (centerMode !== false) {
          if (w === null || h === null) return { converted: false, reason: "centered rect() with non-static size" };
          endCursor = { ...cursor };
          if (centerMode === true) at = { x: cursor.x - w / 2, y: cursor.y - h / 2 };
          else if (centerMode === "horizontal") at = { x: cursor.x - w / 2, y: cursor.y };
          else at = { x: cursor.x, y: cursor.y - h / 2 };
        }
        if (mode === "primitives" && (w === null || h === null)) {
          return { converted: false, reason: "non-static rect() size (primitives mode)" };
        }
        emitRect(bindName ? `const ${bindName} = ` : null, wNode.getText(), hNode.getText(), at, w, h);
        // pen lands at `end` (legacy Rect.build); unknown-size non-centered
        // rect leaves the cursor unknown
        cursor = (w === null || h === null) ? (centerMode !== false ? endCursor : null) : endCursor;
        sawLegacy = true;
        break;
      }
      default:
        return { converted: false, reason: `unknown callee ${callee}()` };
    }
  }

  closeChainIfLoop();
  if (!sawLegacy) return { converted: false, reason: "nothing legacy to convert" };

  // Reassemble: geometry first, then constraints (layout convention), with
  // any return statement last.
  const returns = geometry.filter(s => s.startsWith("__RETURN__")).map(s => s.slice("__RETURN__".length));
  const geo = geometry.filter(s => !s.startsWith("__RETURN__"));
  return {
    converted: true,
    usedTestRect,
    usedNames: used,
    newBody: [...geo, ...constraints, ...returns],
  };
}

function processFile(file: SourceFile, mode: "test" | "primitives", write: boolean) {
  const names = new NameAlloc(file);
  const report: string[] = [];
  let changed = false;
  let needsTestRect = false;
  const neededNames = new Set<string>();

  const sketchCalls = file.getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(c => {
      const e = c.getExpression();
      return Node.isIdentifier(e) && e.getText() === "sketch";
    });

  for (const call of sketchCalls) {
    const cbArg = call.getArguments()[1];
    if (!cbArg || (!Node.isArrowFunction(cbArg) && !Node.isFunctionExpression(cbArg))) {
      report.push(`  skip: sketch() without inline callback @ line ${call.getStartLineNumber()}`);
      continue;
    }
    const fn = cbArg as ArrowFunction | FunctionExpression;
    const bodyNode = fn.getBody();
    const line = call.getStartLineNumber();
    if (!Node.isBlock(bodyNode)) {
      report.push(`  skip: concise arrow body @ line ${line}`);
      continue;
    }
    const planeArg = call.getArguments()[0];
    // Canonical (pen origin provably local [0,0]): a string plane, or a
    // plane("<string>", ...) derivative — offsets/rotations keep the plane
    // center at the local origin. Face-derived planes stay non-canonical.
    const planeIsCanonical = !!planeArg && (Node.isStringLiteral(planeArg) ||
      (Node.isCallExpression(planeArg) &&
        planeArg.getExpression().getText() === "plane" &&
        !!planeArg.getArguments()[0] && Node.isStringLiteral(planeArg.getArguments()[0])));
    const res = convertCallback(bodyNode.getStatements(), names, mode, planeIsCanonical);

    if (!res.converted) {
      if (res.reason !== "nothing legacy to convert") {
        report.push(`  skip @ line ${line}: ${res.reason}`);
      }
      continue;
    }

    const indent = " ".repeat(4);
    const newText = `{\n${res.newBody!.map(s => indent + s).join("\n")}\n  }`;
    (bodyNode as any).replaceWithText(newText);
    changed = true;
    if (res.usedTestRect) needsTestRect = true;
    for (const n of res.usedNames!) neededNames.add(n);
    report.push(`  converted sketch @ line ${line}`);
  }

  if (changed) {
    fixImports(file, neededNames, needsTestRect);
    if (write) file.saveSync();
  }
  return { changed, report };
}

const CONSTRAINT_NAMES = new Set([
  "coincident", "horizontal", "vertical", "parallel", "perpendicular",
  "tangent", "equal", "concentric", "collinear", "midpoint", "symmetric",
  "distance", "angle", "radius", "diameter", "fix",
]);

function fixImports(file: SourceFile, needed: Set<string>, needsTestRect: boolean) {
  let core2dImport: import("ts-morph").ImportDeclaration | null = null;
  for (const imp of file.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (spec.endsWith("2d/index.js") || spec === "fluidcad/core") core2dImport = imp;
  }

  // Drop legacy names that no longer appear in the file body.
  if (core2dImport) {
    for (const named of core2dImport.getNamedImports()) {
      const n = named.getName();
      if (!LEGACY_IMPORT_NAMES.has(n)) continue;
      const stillUsed = file.getDescendantsOfKind(SyntaxKind.Identifier)
        .some(id => id.getText() === n && id.getParent() !== named &&
          !Node.isImportSpecifier(id.getParent()));
      if (!stillUsed) named.remove();
    }
    // Ensure entity callees we emitted are imported.
    const have = new Set(core2dImport.getNamedImports().map(n => n.getName()));
    for (const n of ["line", "circle"]) {
      if (needed.has(n) && !have.has(n)) core2dImport.addNamedImport(n);
    }
  }

  // Constraint imports.
  const constraintNames = [...needed].filter(n => CONSTRAINT_NAMES.has(n)).sort();
  if (constraintNames.length > 0) {
    let constraintImport = file.getImportDeclarations().find(imp => {
      const s = imp.getModuleSpecifierValue();
      return s.endsWith("core/constraints/index.js") || s === "fluidcad/constraints";
    });
    if (!constraintImport) {
      const base = core2dImport?.getModuleSpecifierValue();
      const spec = base === "fluidcad/core" || !base
        ? "fluidcad/constraints"
        : base.replace(/2d\/index\.js$/, "constraints/index.js");
      constraintImport = file.addImportDeclaration({ moduleSpecifier: spec, namedImports: [] });
    }
    const have = new Set(constraintImport.getNamedImports().map(n => n.getName()));
    for (const n of constraintNames) if (!have.has(n)) constraintImport.addNamedImport(n);
  }

  if (needsTestRect) {
    const filePath = file.getFilePath();
    const helpersAbs = path.resolve(process.cwd(), "lib/tests/helpers/profiles.js");
    let rel = path.relative(path.dirname(filePath), helpersAbs).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    const existing = file.getImportDeclarations().find(i => i.getModuleSpecifierValue().endsWith("helpers/profiles.js"));
    if (existing) {
      const have = new Set(existing.getNamedImports().map(n => n.getName()));
      if (!have.has("testRect")) existing.addNamedImport("testRect");
    } else {
      file.addImportDeclaration({ moduleSpecifier: rel, namedImports: ["testRect"] });
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const modeArg = argv.find(a => a.startsWith("--mode="));
  const mode = (modeArg ? modeArg.split("=")[1] : "test") as "test" | "primitives";
  const files = argv.filter(a => !a.startsWith("--"));
  if (files.length === 0) {
    console.error("usage: tsx scripts/modernize-sketch.ts [--mode=test|primitives] [--write] <files...>");
    process.exit(1);
  }
  const project = new Project({ compilerOptions: { allowJs: true }, skipAddingFilesFromTsConfig: true });
  let convertedFiles = 0;
  for (const f of files) {
    const sf = project.addSourceFileAtPath(f);
    const { changed, report } = processFile(sf, mode, write);
    if (report.length > 0 || changed) {
      console.log(`${f}${changed ? (write ? "  [written]" : "  [would change]") : ""}`);
      for (const l of report) console.log(l);
    }
    if (changed) convertedFiles += 1;
  }
  console.log(`\n${convertedFiles}/${files.length} files ${write ? "rewritten" : "would change"} (mode=${mode})`);
}

main();

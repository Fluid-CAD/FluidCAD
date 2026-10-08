/**
 * The expression-input logic shared by the sketcher's floating input and the
 * feature dialogs' inline fields: identifier grammar, commit classification
 * (plain expression vs `name = value` declaration), suggestion filtering,
 * and the dropdown item markup. Pure functions — the hosts own the DOM.
 */

export const IDENT_RE = /^[a-zA-Z_$][\w$]*$/;
/**
 * The name being typed at the end of a value — dotted, so `drawer.prop` and
 * `drawer.` both read as one token the dropdown completes to
 * `drawer.properties.width`, the way an inserted instance's property is spelled.
 */
export const TRAILING_IDENT_RE = /([a-zA-Z_$][\w$]*(?:\.[\w$]*)*)$/;
export const ASSIGNMENT_RE = /^([a-zA-Z_$][\w$]*)\s*=\s*(.+?)\s*;?\s*$/;

const RESERVED = new Set([
  'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'return', 'function',
  'class', 'new', 'this', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof',
  'switch', 'case', 'break', 'continue', 'default', 'try', 'catch', 'finally', 'throw',
  'in', 'of', 'delete', 'void', 'yield', 'async', 'await', 'import', 'export', 'from',
  'as', 'extends', 'super', 'static', 'enum', 'interface', 'implements', 'package',
  'private', 'protected', 'public',
]);

export function isValidNewIdentifier(s: string): boolean {
  return IDENT_RE.test(s) && !RESERVED.has(s);
}

/** `numeric: false` marks a variable whose value is not a plain constant or
 * arithmetic expression (e.g. a feature result like `extrude(...)`) — kept in
 * the list for name-collision checks but hidden from the dropdown.
 * `unbound` marks a `property()` the part publishes without binding a
 * variable (`property('Label', 'name', value);` on its own, as the
 * Parameters panel writes it): its initializer is the whole call, and the
 * first commit that reads the name declares it over that call — the server
 * binds the existing declaration rather than writing a second one. */
export type VariableInfo = { name: string; initializer?: string; numeric?: boolean; unbound?: boolean };

export type Suggestion = VariableInfo & { isNew?: boolean };

/**
 * What a committed input writes. A `declare` carries the `const name =
 * initializer` to land with the statement and the `expression` the
 * statement reads: the bare name for a new variable, the typed text for
 * one that binds a part's unbound `property()` (`property: true`) — that
 * text may use the name inside arithmetic.
 */
export type ClassifiedCommit =
  | { kind: 'expression'; expression: string }
  | { kind: 'declare'; name: string; initializer: string; expression: string; property?: boolean }
  | { kind: 'error'; message: string };

/**
 * The name a committed input would declare — an explicit `name = value`, or a
 * fresh identifier (no existing-variable match) over a seed value. Null when
 * the commit is a plain expression, an error, or binds an existing
 * property — drives the hosts' "declare as param" toggle visibility.
 */
export function declaredVariableName(
  raw: string,
  variables: VariableInfo[],
  seedValue: string,
): string | null {
  const classified = classifyCommit(raw, variables, seedValue);
  return classified.kind === 'declare' && !classified.property ? classified.name : null;
}

/** A declaration initializer wrapped as a `param()` call, labeled by name — single-quoted, like the rest of the source the UI writes. */
export function paramInitializer(name: string, initializer: string): string {
  return `param('${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', ${initializer})`;
}

/**
 * The "declare as param()" toggle's state, shared by every expression input
 * of the session — the sketcher's floating input and the dialogs' fields
 * alike. On by default: naming a value is, more often than not, making it a
 * parameter. A flip in one input is what the next one opens with, so the
 * user sets it once rather than per field; it lasts the page session.
 */
export class ParamDeclareMode {
  private static on = true;

  static get enabled(): boolean {
    return ParamDeclareMode.on;
  }

  static toggle(): void {
    ParamDeclareMode.on = !ParamDeclareMode.on;
  }

  static set(enabled: boolean): void {
    ParamDeclareMode.on = enabled;
  }
}

/**
 * Read a committed input into what it writes: `name = value` declares a new
 * variable, a bare unknown identifier declares one from the seed value (the
 * field's last plain number), anything else passes through as the expression.
 * With `asParam`, a declaration's initializer is wrapped as a `param()` call.
 * With `arithmeticOnly`, declarations are off the table entirely and the text
 * must evaluate to a finite number (hosts that write numbers, not source
 * expressions — the assembly gizmo's value input).
 */
export function classifyCommit(
  raw: string,
  variables: VariableInfo[],
  seedValue: string,
  numericOnly = false,
  asParam = false,
  arithmeticOnly = false,
): ClassifiedCommit {
  if (numericOnly) {
    const num = parseFloat(raw);
    if (isNaN(num)) {
      return { kind: 'error', message: 'Enter a numeric value' };
    }
    return { kind: 'expression', expression: raw };
  }

  if (arithmeticOnly) {
    if (resolveExpressionValue(raw, variables) === null) {
      return { kind: 'error', message: 'Enter a number or expression' };
    }
    return { kind: 'expression', expression: raw };
  }

  const assignMatch = raw.match(ASSIGNMENT_RE);
  if (assignMatch) {
    const name = assignMatch[1];
    const rhs = assignMatch[2].trim();
    if (!isValidNewIdentifier(name)) {
      return { kind: 'error', message: `'${name}' is not a valid name` };
    }
    if (variables.some((v) => v.name === name)) {
      return { kind: 'error', message: `'${name}' is already defined` };
    }
    if (!rhs) {
      return { kind: 'error', message: 'Missing value' };
    }
    const [unbound] = unboundPropertiesIn(rhs, variables);
    if (unbound) {
      return { kind: 'error', message: bindFirstMessage(unbound.name) };
    }
    return {
      kind: 'declare', name, initializer: asParam ? paramInitializer(name, rhs) : rhs, expression: name,
    };
  }

  if (IDENT_RE.test(raw) && !variables.some((v) => v.name === raw) && isValidNewIdentifier(raw)) {
    const initializer = seedValue.trim();
    if (!initializer) {
      return { kind: 'error', message: 'No value to assign' };
    }
    return {
      kind: 'declare',
      name: raw,
      initializer: asParam ? paramInitializer(raw, initializer) : initializer,
      expression: raw,
    };
  }

  // Reading a property the part publishes without binding it binds it: the
  // commit declares the name over the property's own call, and the server
  // moves that declaration up to where the statement reads it. One per
  // commit — a second has to wait for the next.
  const [first, second] = unboundPropertiesIn(raw, variables);
  if (second) {
    return { kind: 'error', message: bindFirstMessage(first.name) };
  }
  if (first) {
    return {
      kind: 'declare', name: first.name, initializer: first.initializer!, expression: raw, property: true,
    };
  }
  return { kind: 'expression', expression: raw };
}

/** Every identifier `text` reads — a name after a `.` is a member, not one. */
const READ_IDENT_RE = /(?<![\w$.])[a-zA-Z_$][\w$]*/g;

/** The unbound properties `text` reads, in reading order, each once. */
function unboundPropertiesIn(text: string, variables: VariableInfo[]): VariableInfo[] {
  const found: VariableInfo[] = [];
  for (const [name] of text.matchAll(READ_IDENT_RE)) {
    const variable = variables.find((v) => v.name === name && v.unbound && v.initializer);
    if (variable && !found.includes(variable)) {
      found.push(variable);
    }
  }
  return found;
}

function bindFirstMessage(name: string): string {
  return `Use '${name}' on its own first — that binds the property`;
}

type ArithToken =
  | { kind: 'num'; value: number }
  | { kind: 'name'; name: string }
  | { kind: 'op'; op: string };

function tokenizeArithmetic(text: string): ArithToken[] | null {
  const tokens: ArithToken[] = [];
  const re = /(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([a-zA-Z_$][\w$]*)|([()+\-*/%])|(\s+)|(.)/g;
  for (const match of text.matchAll(re)) {
    if (match[1] !== undefined) {
      tokens.push({ kind: 'num', value: parseFloat(match[1]) });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: 'name', name: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ kind: 'op', op: match[3] });
    } else if (match[5] !== undefined) {
      return null;
    }
  }
  return tokens;
}

/**
 * Evaluate arithmetic — numbers, `+ - * / %`, parentheses, unary sign —
 * with identifiers supplied by `lookup`. Null when the text reaches beyond
 * that grammar or an identifier doesn't resolve.
 */
function evaluateArithmetic(
  text: string,
  lookup: (name: string) => number | null,
): number | null {
  const tokens = tokenizeArithmetic(text);
  if (!tokens || tokens.length === 0) {
    return null;
  }
  let pos = 0;

  const nextOp = (...ops: string[]): string | null => {
    const token = tokens[pos];
    if (token && token.kind === 'op' && ops.includes(token.op)) {
      return token.op;
    }
    return null;
  };

  const parsePrimary = (): number | null => {
    const token = tokens[pos];
    if (!token) {
      return null;
    }
    if (token.kind === 'num') {
      pos += 1;
      return token.value;
    }
    if (token.kind === 'name') {
      pos += 1;
      return lookup(token.name);
    }
    if (token.op === '(') {
      pos += 1;
      const inner = parseAdditive();
      if (inner === null || nextOp(')') === null) {
        return null;
      }
      pos += 1;
      return inner;
    }
    return null;
  };

  const parseUnary = (): number | null => {
    const sign = nextOp('+', '-');
    if (sign !== null) {
      pos += 1;
      const operand = parseUnary();
      if (operand === null) {
        return null;
      }
      return sign === '-' ? -operand : operand;
    }
    return parsePrimary();
  };

  const parseMultiplicative = (): number | null => {
    let left = parseUnary();
    while (left !== null) {
      const op = nextOp('*', '/', '%');
      if (op === null) {
        break;
      }
      pos += 1;
      const right = parseUnary();
      if (right === null) {
        return null;
      }
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  };

  const parseAdditive = (): number | null => {
    let left = parseMultiplicative();
    while (left !== null) {
      const op = nextOp('+', '-');
      if (op === null) {
        break;
      }
      pos += 1;
      const right = parseMultiplicative();
      if (right === null) {
        return null;
      }
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };

  const result = parseAdditive();
  return pos === tokens.length ? result : null;
}

const PARAM_INIT_RE = /^param\(\s*(['"`])[^'"`]*\1\s*,\s*([\s\S]+)\)\s*;?\s*$/;
const PROPERTY_INIT_RE =
  /^property\(\s*(['"`])[^'"`]*\1\s*,\s*(['"`])[^'"`]*\2\s*,\s*([\s\S]+)\)\s*;?\s*$/;

/** A `param('name', value)` or `property('Label', 'name', value)` initializer contributes its value expression. */
function unwrapDeclaration(initializer: string): string {
  const trimmed = initializer.trim();
  const param = trimmed.match(PARAM_INIT_RE);
  if (param) {
    return param[2];
  }
  const property = trimmed.match(PROPERTY_INIT_RE);
  return property ? property[3] : initializer;
}

/**
 * Best-effort numeric value of a committed expression, for previews only:
 * arithmetic over the in-scope variables, with identifiers resolved
 * recursively through their initializers (`param()` and `property()`
 * wrappers unwrapped).
 * Null when the expression reaches beyond plain arithmetic (function calls,
 * unknown names, non-numeric initializers, cycles) or doesn't yield a finite
 * number — callers fall back to the live cursor value until the re-render
 * lands.
 */
export function resolveExpressionValue(
  expression: string,
  variables: VariableInfo[],
  newVariable?: { name: string; initializer: string } | null,
): number | null {
  const evaluate = (text: string, seen: Set<string>): number | null =>
    evaluateArithmetic(text, (name) => {
      if (seen.has(name)) {
        return null;
      }
      const initializer = newVariable?.name === name
        ? newVariable.initializer
        : variables.find((v) => v.name === name)?.initializer;
      if (!initializer || !initializer.trim()) {
        return null;
      }
      return evaluate(unwrapDeclaration(initializer), new Set(seen).add(name));
    });

  const value = evaluate(expression, new Set());
  return value !== null && isFinite(value) ? value : null;
}

/** The identifier being typed at the end of the value, or null. */
export function trailingIdentifier(value: string): string | null {
  const match = value.match(TRAILING_IDENT_RE);
  return match ? match[1] : null;
}

/** Replace the trailing identifier of `value` with `name` (autocomplete fill). */
export function applyVariableName(value: string, name: string): string {
  const match = value.match(TRAILING_IDENT_RE);
  if (match && match.index !== undefined) {
    return value.slice(0, match.index) + name;
  }
  return value + name;
}

function matchRank(name: string, lowerQuery: string): number {
  const lowerName = name.toLowerCase();
  if (lowerName === lowerQuery) {
    return 0;
  }
  if (lowerName.startsWith(lowerQuery)) {
    return 1;
  }
  return 2;
}

/**
 * The dropdown entries for the identifier being typed: matching variables
 * (exact, then prefix, then substring), plus a "new variable" offer when the
 * whole value is a fresh valid name and a seed value exists to assign.
 * Variables marked `numeric: false` (feature results and other non-value
 * bindings) are hidden — only constants and expressions are offered.
 */
export function filterSuggestions(
  query: string,
  variables: VariableInfo[],
  fullValue: string,
  seedValue: string,
): Suggestion[] {
  const lower = query.toLowerCase();
  const matches: Suggestion[] = variables.filter(
    (v) => v.numeric !== false && v.name.toLowerCase().includes(lower),
  );
  matches.sort((a, b) => matchRank(a.name, lower) - matchRank(b.name, lower));
  if (shouldOfferNewVariable(query, variables, fullValue, seedValue)) {
    matches.push({ name: query, initializer: seedValue.trim(), isNew: true });
  }
  return matches;
}

/**
 * Whether the dropdown lists an existing variable for the bare name being
 * typed. While it does, the name reads as a reference in the making — Enter
 * picks the match — so the hosts keep the P toggle out of the way, though
 * the name alone would declare a new variable. An explicit `name = value`
 * never counts: its matches complete the value, not the declared name.
 */
export function suggestsExistingName(raw: string, suggestions: Suggestion[]): boolean {
  return IDENT_RE.test(raw.trim()) && suggestions.some((s) => !s.isNew);
}

function shouldOfferNewVariable(
  query: string,
  variables: VariableInfo[],
  fullValue: string,
  seedValue: string,
): boolean {
  if (!query || fullValue.trim() !== query) {
    return false;
  }
  if (!isValidNewIdentifier(query)) {
    return false;
  }
  if (variables.some((v) => v.name === query)) {
    return false;
  }
  return seedValue.trim().length > 0;
}

export function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** What a dropdown entry names: a `param()` declaration, a `property()` the
 * part publishes, a plain value (a number literal, or an import whose value
 * the file doesn't show), or a value computed from any other expression. */
export type SuggestionKind = 'param' | 'property' | 'variable' | 'expression';

/**
 * A suggestion's kind, read off its initializer. The new-variable offer is
 * what committing it would declare — a `param()` while the host's P toggle is
 * on (`newAsParam`), a plain value otherwise.
 */
export function suggestionKind(v: Suggestion, newAsParam: boolean): SuggestionKind {
  if (v.isNew) {
    return newAsParam ? 'param' : 'variable';
  }
  const initializer = v.initializer?.trim() ?? '';
  if (PARAM_INIT_RE.test(initializer)) {
    return 'param';
  }
  if (PROPERTY_INIT_RE.test(initializer)) {
    return 'property';
  }
  if (!initializer || Number.isFinite(Number(initializer))) {
    return 'variable';
  }
  return 'expression';
}

/** The chip before each row's name — P wears the input's own P-toggle blue. */
const KIND_CHIPS: Record<SuggestionKind, { letter: string; title: string; colors: string }> = {
  param: {
    letter: 'P',
    title: 'Parameter — param()',
    colors: 'bg-primary/20 text-primary border-primary/40',
  },
  property: {
    letter: 'Pr',
    title: 'Property — property()',
    colors: 'bg-property/20 text-property border-property/40',
  },
  variable: {
    letter: 'V',
    title: 'Variable',
    colors: 'bg-variable/20 text-variable border-variable/40',
  },
  expression: {
    letter: 'E',
    title: 'Expression',
    colors: 'bg-base-content/10 text-base-content/60 border-base-content/20',
  },
};

/**
 * The value an inserted instance's property row shows beside its name: the
 * number the last render computed. The file never spells that value — it
 * is the part's to compute — so the row is the only place to read it.
 * Nothing for every other row, whose value the file shows.
 */
export function suggestionValueHint(v: Suggestion): string | null {
  const initializer = v.initializer?.trim() ?? '';
  return !v.isNew && v.name.includes('.properties.') && initializer !== '' && Number.isFinite(Number(initializer))
    ? initializer
    : null;
}

/**
 * One dropdown row's markup, shared so every host renders identically: the
 * kind chip, then the name, then — an instance property — its rendered
 * value. `newAsParam` is the host's P-toggle state, which picks the
 * new-variable offer's chip.
 */
export function suggestionItemHtml(
  v: Suggestion,
  index: number,
  active: boolean,
  newAsParam: boolean,
): string {
  const activeClass = active ? 'bg-primary/10' : '';
  const chip = KIND_CHIPS[suggestionKind(v, newAsParam)];
  const chipHtml = `<span title="${chip.title}" class="inline-flex items-center justify-center shrink-0 min-w-4 h-4 px-0.5 rounded border text-[10px] font-semibold leading-none select-none ${chip.colors}">${chip.letter}</span>`;
  const badge = v.isNew
    ? '<span class="text-primary/70 ml-0.5 text-[10px] uppercase select-none">new</span>'
    : '';
  const hint = suggestionValueHint(v);
  const hintHtml = hint === null
    ? ''
    : `<span class="ml-auto pl-3 text-base-content/50 select-none">${escapeHtml(hint)}</span>`;
  return `<div class="flex items-center gap-1.5 px-2 py-1 text-sm font-mono cursor-pointer hover:bg-primary/10 ${activeClass}" data-idx="${index}">${chipHtml}<span>${escapeHtml(v.name)}</span>${badge}${hintHtml}</div>`;
}

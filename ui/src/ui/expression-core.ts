/**
 * The expression-input logic shared by the sketcher's floating input and the
 * feature dialogs' inline fields: identifier grammar, commit classification
 * (plain expression vs `name = value` declaration), suggestion filtering,
 * and the dropdown item markup. Pure functions — the hosts own the DOM.
 */

export const IDENT_RE = /^[a-zA-Z_$][\w$]*$/;
export const TRAILING_IDENT_RE = /([a-zA-Z_$][\w$]*)$/;
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
 * the list for name-collision checks but hidden from the dropdown. */
export type VariableInfo = { name: string; initializer?: string; numeric?: boolean };

export type Suggestion = VariableInfo & { isNew?: boolean };

export type ClassifiedCommit =
  | { kind: 'expression'; expression: string }
  | { kind: 'declare'; name: string; initializer: string }
  | { kind: 'error'; message: string };

/**
 * The name a committed input would declare — an explicit `name = value`, or a
 * fresh identifier (no existing-variable match) over a seed value. Null when
 * the commit is a plain expression or an error — drives the hosts' "declare
 * as param" toggle visibility.
 */
export function declaredVariableName(
  raw: string,
  variables: VariableInfo[],
  seedValue: string,
): string | null {
  const classified = classifyCommit(raw, variables, seedValue);
  return classified.kind === 'declare' ? classified.name : null;
}

/** A declaration initializer wrapped as a `param()` call, labeled by name. */
export function paramInitializer(name: string, initializer: string): string {
  return `param("${name}", ${initializer})`;
}

/**
 * Read a committed input into what it writes: `name = value` declares a new
 * variable, a bare unknown identifier declares one from the seed value (the
 * field's last plain number), anything else passes through as the expression.
 * With `asParam`, a declaration's initializer is wrapped as a `param()` call.
 */
export function classifyCommit(
  raw: string,
  variables: VariableInfo[],
  seedValue: string,
  numericOnly = false,
  asParam = false,
): ClassifiedCommit {
  if (numericOnly) {
    const num = parseFloat(raw);
    if (isNaN(num)) {
      return { kind: 'error', message: 'Enter a numeric value' };
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
    return { kind: 'declare', name, initializer: asParam ? paramInitializer(name, rhs) : rhs };
  }

  if (IDENT_RE.test(raw)) {
    if (variables.some((v) => v.name === raw)) {
      return { kind: 'expression', expression: raw };
    }
    if (!isValidNewIdentifier(raw)) {
      return { kind: 'expression', expression: raw };
    }
    const initializer = seedValue.trim();
    if (!initializer) {
      return { kind: 'error', message: 'No value to assign' };
    }
    return {
      kind: 'declare',
      name: raw,
      initializer: asParam ? paramInitializer(raw, initializer) : initializer,
    };
  }

  return { kind: 'expression', expression: raw };
}

/**
 * Best-effort numeric value of a committed expression, for previews only: a
 * plain number resolves to itself, a variable to its literal initializer.
 * Null when the value can't be resolved statically (e.g. `w / 2`) — callers
 * fall back to the live cursor value until the re-render lands.
 */
export function resolveExpressionValue(
  expression: string,
  variables: VariableInfo[],
  newVariable?: { name: string; initializer: string } | null,
): number | null {
  const trimmed = expression.trim();
  const direct = Number(trimmed);
  if (trimmed && !isNaN(direct) && isFinite(direct)) {
    return direct;
  }

  const initializer = newVariable?.initializer
    ?? variables.find((v) => v.name === trimmed)?.initializer;
  if (!initializer || !initializer.trim()) {
    return null;
  }

  const parsed = Number(initializer.trim());
  return isNaN(parsed) || !isFinite(parsed) ? null : parsed;
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

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

/** One dropdown row's markup, shared so both hosts render identically. */
export function suggestionItemHtml(v: Suggestion, index: number, active: boolean): string {
  const activeClass = active ? 'bg-primary/10' : '';
  const hint = v.initializer
    ? `<span class="text-base-content/40 ml-2">= ${escapeHtml(truncate(v.initializer, 20))}</span>`
    : '';
  const badge = v.isNew
    ? '<span class="text-primary/70 ml-2 text-[10px] uppercase select-none">new</span>'
    : '';
  return `<div class="px-2 py-1 text-sm font-mono cursor-pointer hover:bg-primary/10 ${activeClass}" data-idx="${index}">${escapeHtml(v.name)}${hint}${badge}</div>`;
}

// The arguments of a statement written from rows of curve or surface picks: what each row takes, and the check, rendering, read-back and edit every such statement runs on them.

import type { TSNode } from '../../code-editor/index.ts';
import type { ApplyFeatureEditSpec, EditRenderSpec } from '../spec.ts';
import { OperandPicks, type OperandEdit, type OperandPick } from './operand-picks.ts';

/** What a row's picks are: curves and edges, or surfaces and faces (see {@link OperandPicks.validate}). */
export type OperandRowKind = 'curve' | 'surface';

/** One argument of an operand-row statement: the dialog row it is written from. */
export type OperandRow = {
  /** What its picks are. */
  kind: OperandRowKind;
  /** The argument as a refusal names it: `the first selection`, `the source`. */
  label: string;
  /** What an empty row is asked to hold: `a surface or faces`. */
  wants: string;
};

/** Each row's picks, by row, as a create spec carries them. */
export type RowPicks<R extends string> = Record<R, OperandPick[]>;

/** Each row of an edit, by row: the statement's own argument kept as written (an absent row too), or re-picked. */
export type RowEdits<R extends string> = Partial<Record<R, OperandEdit>>;

/** The statement a bare variable names, by its call site; null for any other expression. */
type OperandRef = { line: number; column: number } | null;

/**
 * Each row read back, as a parsed statement carries it: `<row>Texts`, its
 * operands verbatim — a list's elements, or the bare expression; `<row>Refs`,
 * the statement each one names (same length); `<row>Arg`, the argument as
 * written, which a kept row writes again.
 */
export type ParsedOperandRows<R extends string> =
  & { [K in R as `${K}Texts`]: string[] }
  & { [K in R as `${K}Refs`]: OperandRef[] }
  & { [K in R as `${K}Arg`]: string };

/** What an operand-row statement is written from, and the words of its refusals. */
export type OperandRowStatement<R extends string> = {
  /** The callee the statement calls, which an empty row's refusal starts with. */
  callee: string;
  /** The tool as a malformed spec's refusal names it: `intersection curve`. */
  tool: string;
  /** The rows, in argument order. */
  rows: Readonly<Record<R, OperandRow>>;
  /** The refusal of a statement whose arguments are not its rows, one each: the dialog cannot show it. */
  shapeError: string;
};

/**
 * The arguments of a statement written from rows of curve or surface picks
 * — `intersect(first, second)`, `project(source, target)` — and what every
 * such statement does with them alike: a create spec's rows checked and
 * rendered, the rows read back out of the statement, an edit's rows kept
 * verbatim or re-picked, and every selector part rendered exactly once. A
 * tool adds its own options around them.
 */
export class OperandRows<R extends string> {
  /** The rows, in argument order. */
  readonly names: readonly R[];
  /** What each row takes, by row: how a request's picks for it are read. */
  readonly kinds: Readonly<Record<R, OperandRowKind>>;

  constructor(private readonly statement: OperandRowStatement<R>) {
    this.names = Object.keys(statement.rows) as R[];
    this.kinds = this.byRow(row => statement.rows[row].kind);
  }

  /** The refusal of a spec the dialog does not send, with what is wrong when given. */
  malformed(detail?: string): string {
    const refusal = `malformed ${this.statement.tool} edit spec`;
    return detail === undefined ? refusal : `${refusal}: ${detail}`;
  }

  /** The call with each row's argument in its place, in row order: `intersect(<first>, <second>)`. */
  call(args: Record<R, string>): string {
    return `${this.statement.callee}(${this.names.map(row => args[row]).join(', ')})`;
  }

  /** The argument each row writes: its picks in pick order, one bare, several as a list (see {@link OperandPicks.argument}). */
  arguments(
    picks: RowPicks<R>,
    parts: ApplyFeatureEditSpec['parts'],
    varFor: (producer: number) => string | null,
  ): Record<R, string> {
    return this.byRow(row => OperandPicks.argument(OperandPicks.render(picks[row], parts, varFor)));
  }

  /**
   * Checks a create spec's rows — each a list of picks of its row's kind,
   * none empty — and answers the selector parts they render, or the
   * refusal of the first row that fails.
   */
  check(
    picks: Record<R, unknown>,
    spec: Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>,
  ): { parts: number[] } | { error: string } {
    const parts: number[] = [];
    for (const row of this.names) {
      const valid = this.rowPicks(row, picks[row], spec);
      if ('error' in valid) {
        return valid;
      }
      parts.push(...selectorParts(valid));
    }
    return { parts };
  }

  /**
   * An edited statement's arguments: a kept row (an absent one too) writes
   * its argument as the statement has it, a re-picked row its picks, each
   * producer under `varFor`'s variable or else its own hint. Answers the
   * selector parts the re-picked rows render, or the refusal of the first
   * row that fails.
   */
  edited(
    edit: RowEdits<R>,
    parsed: ParsedOperandRows<R>,
    spec: EditRenderSpec,
    varFor: (producer: number) => string | null,
  ): { args: Record<R, string>; parts: number[] } | { error: string } {
    const name = OperandPicks.editNamer(spec, varFor);
    const parts: number[] = [];
    const args = {} as Record<R, string>;
    for (const row of this.names) {
      const rowEdit = edit[row];
      if (rowEdit === undefined || rowEdit.kind === 'keep') {
        args[row] = OperandRows.keptArgument(parsed, row);
        continue;
      }
      if (rowEdit.kind !== 'picks') {
        return { error: this.malformed(`${this.statement.rows[row].label} is neither kept nor picked`) };
      }
      const picks = this.rowPicks(row, rowEdit.picks, spec);
      if ('error' in picks) {
        return picks;
      }
      parts.push(...selectorParts(picks));
      args[row] = OperandPicks.argument(OperandPicks.render(picks, spec.parts, name));
    }
    return { args, parts };
  }

  /**
   * Reads the rows back from a call whose arguments they are, one each, in
   * row order. Any other argument list — another count, a spread — is not a
   * form the dialog shows, and is refused.
   */
  parse(args: TSNode[], start: number): ParsedOperandRows<R> | { error: string } {
    if (args.length !== this.names.length || args.some(arg => arg.type === 'spread_element')) {
      return { error: this.statement.shapeError };
    }
    return this.read(this.byRow(row => args[this.names.indexOf(row)]), start);
  }

  /**
   * Reads each row back from the argument it is written as (see
   * {@link OperandPicks.parse}): verbatim, so nothing is refused here.
   */
  read(args: Record<R, TSNode>, start: number): ParsedOperandRows<R> {
    const fields: Record<string, string | string[] | OperandRef[]> = {};
    for (const row of this.names) {
      const operands = OperandPicks.parse(args[row], start);
      fields[`${row}Texts`] = operands.texts;
      fields[`${row}Refs`] = operands.refs;
    }
    for (const row of this.names) {
      fields[`${row}Arg`] = args[row].text;
    }
    return fields as ParsedOperandRows<R>;
  }

  /**
   * Why the selector parts the statement renders do not account for the
   * spec's, or null: each part must be rendered exactly once — by a row's
   * pick, or by whatever else `owners` names (`one pick or the direction`)
   * — or a part would be lost.
   */
  partsError(parts: number[], spec: Pick<ApplyFeatureEditSpec, 'parts'>, owners = 'one pick'): string | null {
    return parts.length === spec.parts.length && new Set(parts).size === parts.length
      ? null
      : this.malformed(`every selector part belongs to exactly ${owners}`);
  }

  /** One row's picks, checked as its kind's: a refusal names the row, an empty row says what it wants. */
  private rowPicks(
    row: R,
    picks: unknown,
    spec: Pick<ApplyFeatureEditSpec, 'producers' | 'parts'>,
  ): OperandPick[] | { error: string } {
    const { kind, label, wants } = this.statement.rows[row];
    const valid = OperandPicks.validate(kind, picks, label, spec);
    if ('error' in valid) {
      return { error: this.malformed(valid.error) };
    }
    if (valid.length === 0) {
      return { error: `${this.statement.callee}: ${label} is empty — pick ${wants} for it` };
    }
    return valid;
  }

  /** A record with one entry per row, in row order. */
  private byRow<V>(value: (row: R) => V): Record<R, V> {
    const record = {} as Record<R, V>;
    for (const row of this.names) {
      record[row] = value(row);
    }
    return record;
  }

  /** The argument a kept row writes again: the statement's own. */
  private static keptArgument<R extends string>(parsed: ParsedOperandRows<R>, row: R): string {
    return (parsed as Record<`${R}Arg`, string>)[`${row}Arg`];
  }
}

function selectorParts(picks: OperandPick[]): number[] {
  return picks.flatMap(pick => pick.kind === 'selector' ? [pick.part] : []);
}

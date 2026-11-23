import type { VariantFacts } from '../chat-types';

/**
 * The numbers a card shows of a scratch build (docs/agent-chat-plan.md §23):
 * bodies, overall size and volume, each with its unit — a line each under a
 * variant's tile (§24), and as differences between the two sides of a
 * change (§25).
 */

/** A build's facts, a line each: bodies (and instances), overall size, volume, with their unit. */
export function factLines(facts: VariantFacts): string[] {
  const lines: string[] = [];
  lines.push(facts.instanceCount !== undefined ? `${count(facts.instanceCount, 'instance')}, ${bodies(facts.solidCount)}` : bodies(facts.solidCount));
  if (facts.size) {
    lines.push(sizeText(facts.size, facts.unit));
  }
  if (facts.volume !== null) {
    lines.push(volumeText(facts.volume, facts.unit));
  }
  return lines;
}

/**
 * One fact of a change: what it was, what it is, and the difference with
 * its sign. `change` is empty when the two are the same, or cannot be
 * compared (one side has none, or they are in different units). `tone`
 * says which way it went, for a quantity that has one.
 */
export type FactChange = {
  label: string;
  before: string;
  after: string;
  change: string;
  tone: 'more' | 'less' | 'same';
};

/** The facts of a change as differences: bodies (and instances), overall size, volume. */
export function factChanges(before: VariantFacts, after: VariantFacts): FactChange[] {
  const rows: FactChange[] = [];
  if (before.instanceCount !== undefined || after.instanceCount !== undefined) {
    rows.push(countRow('Instances', before.instanceCount ?? 0, after.instanceCount ?? 0));
  }
  rows.push(countRow('Bodies', before.solidCount, after.solidCount));
  const sameUnit = before.unit === after.unit;
  if (before.size || after.size) {
    const axes = ['X', 'Y', 'Z'];
    const moved = before.size && after.size && sameUnit
      ? after.size.map((extent, axis) => ({ axis: axes[axis], by: clean(extent - before.size![axis], 2) })).filter((d) => d.by !== 0)
      : [];
    rows.push({
      label: 'Size',
      before: before.size ? sizeText(before.size, before.unit) : 'none',
      after: after.size ? sizeText(after.size, after.unit) : 'none',
      change: moved.map((d) => `${d.axis} ${signed(d.by, 2)}`).join(', ') + (moved.length > 0 ? ` ${after.unit}` : ''),
      tone: moved.length === 0 ? 'same' : moved.every((d) => d.by > 0) ? 'more' : moved.every((d) => d.by < 0) ? 'less' : 'same',
    });
  }
  if (before.volume !== null || after.volume !== null) {
    const by = before.volume !== null && after.volume !== null && sameUnit ? after.volume - before.volume : 0;
    // A difference below what five digits of the volume show is no change the row could name.
    const shown = by !== 0 && volumeText(before.volume!, before.unit) !== volumeText(after.volume!, after.unit);
    rows.push({
      label: 'Volume',
      before: before.volume !== null ? volumeText(before.volume, before.unit) : 'none',
      after: after.volume !== null ? volumeText(after.volume, after.unit) : 'none',
      change: shown ? `${signedSignificant(by)} ${after.unit}³${percent(by, before.volume!)}` : '',
      tone: !shown ? 'same' : by > 0 ? 'more' : 'less',
    });
  }
  return rows;
}

function countRow(label: string, before: number, after: number): FactChange {
  const by = after - before;
  return { label, before: String(before), after: String(after), change: by === 0 ? '' : signed(by, 0), tone: by === 0 ? 'same' : by > 0 ? 'more' : 'less' };
}

function bodies(solids: number): string {
  return `${solids} ${solids === 1 ? 'body' : 'bodies'}`;
}

function count(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : `${noun}s`}`;
}

function sizeText(size: [number, number, number], unit: string): string {
  return `${size.map((extent) => number(extent, 2)).join(' × ')} ${unit}`;
}

function volumeText(volume: number, unit: string): string {
  return `${significant(volume)} ${unit}³`;
}

/** ` (+12.5%)`: the change as a share of what it was; nothing when it was zero. */
function percent(by: number, of: number): string {
  if (of === 0) {
    return '';
  }
  const share = (by / of) * 100;
  const digits = Math.abs(share) < 10 ? 1 : 0;
  const text = new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(Math.abs(share));
  // A share that rounds to nothing is still a change: say it is under the smallest step shown.
  return text === '0' ? ` (${by > 0 ? '+' : '−'}<0.1%)` : ` (${by > 0 ? '+' : '−'}${text}%)`;
}

/** `value` rounded to `decimals`, with float noise (`-0`, `1e-12`) gone. */
function clean(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale) / scale;
  return rounded === 0 ? 0 : rounded;
}

/** `value` with its sign (a real minus), at most `decimals` decimals. */
function signed(value: number, decimals: number): string {
  return `${value > 0 ? '+' : '−'}${number(Math.abs(value), decimals)}`;
}

function signedSignificant(value: number): string {
  return `${value > 0 ? '+' : '−'}${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 }).format(Math.abs(value))}`;
}

/** `value` with at most `decimals` decimals, no trailing zeros. */
function number(value: number, decimals: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals }).format(value);
}

/** A volume: five significant digits tell two builds apart without a row of decimals. */
function significant(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 5 }).format(value);
}

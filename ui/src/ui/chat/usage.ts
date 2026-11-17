import type { TurnUsage } from './chat-types';

/**
 * What a turn used, in a few words: "23k in · 512 out" under the answer,
 * the exact counts (and the cost) in its tooltip. The cost shows only when
 * each use is billed (`billed`: Claude Code on an API key): on a plan the
 * CLI's figure is what the tokens would cost at API prices, not a charge.
 * Null when the CLI reported nothing.
 */
export function usageText(usage: TurnUsage, options: { billed?: boolean } = {}): { short: string; long: string } | null {
  const { inputTokens, outputTokens, costUsd } = usage;
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) {
    return null;
  }
  const short: string[] = [];
  const long: string[] = [];
  if (inputTokens !== undefined) {
    short.push(`${compactCount(inputTokens)} in`);
    long.push(`${inputTokens.toLocaleString('en-US')} input tokens (the context it re-read included)`);
  }
  if (outputTokens !== undefined) {
    short.push(`${compactCount(outputTokens)} out`);
    long.push(`${outputTokens.toLocaleString('en-US')} output tokens`);
  }
  if (costUsd !== undefined) {
    if (options.billed) {
      short.push(money(costUsd));
      long.push(`${money(costUsd)} billed to the API key`);
    } else {
      long.push(`${money(costUsd)} at API prices, which your plan covers`);
    }
  }
  return { short: short.join(' · '), long: `This turn used ${long.join(', ')}.` };
}

/** 950 → "950", 1 500 → "1.5k", 12 400 → "12k", 1 250 000 → "1.3M". */
export function compactCount(n: number): string {
  if (n < 1000) {
    return String(Math.round(n));
  }
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`;
}

function money(usd: number): string {
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

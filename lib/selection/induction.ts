import { Atom } from "./atoms.js";

/**
 * Greedy set-cover induction of a short filter conjunction (design §3.2):
 * pick the atom that eliminates the most non-target survivors, repeat until
 * only the targets survive or the conjunction stops being readable. The cap
 * is 4 rather than the design's ≈3 because isolating a repeat instance needs
 * an `above` + `below` bracket (2 atoms) on top of the shape predicates.
 *
 * `matches` holds each atom's oracle-evaluated match set over the universe
 * (keyed the same way as `targets`/`universe`). Atoms that are not true for
 * every target are unusable — a conjunction containing one could never
 * resolve to the full picked set.
 */
export function induceConjunction<B>(
  atoms: Atom<B>[],
  matches: Map<Atom<B>, Set<number>>,
  targets: Set<number>,
  universe: Set<number>,
  maxAtoms = 4,
): Atom<B>[] | null {
  const usable = atoms.filter(atom => {
    const match = matches.get(atom);
    if (!match) {
      return false;
    }
    for (const key of targets) {
      if (!match.has(key)) {
        return false;
      }
    }
    return true;
  });

  // Greedy is myopic: a high-weight opener can burn the atom budget on a path
  // with no finish. Retry with the failed attempt's opener banned — restarts
  // are cheap (match sets are precomputed) and recover most misses.
  const banned = new Set<Atom<B>>();
  for (let attempt = 0; attempt <= 3; attempt++) {
    const candidates = usable.filter(atom => !banned.has(atom));
    const conjunction = greedyCover(candidates, matches, targets, universe, maxAtoms);
    if (conjunction !== null) {
      return conjunction;
    }
    const opener = firstGreedyPick(candidates, matches, targets, universe);
    if (opener === null) {
      return null;
    }
    banned.add(opener);
  }
  return null;
}

function greedyCover<B>(
  usable: Atom<B>[],
  matches: Map<Atom<B>, Set<number>>,
  targets: Set<number>,
  universe: Set<number>,
  maxAtoms: number,
): Atom<B>[] | null {
  let survivors = new Set(universe);
  const conjunction: Atom<B>[] = [];

  while (!setEquals(survivors, targets) && conjunction.length < maxAtoms) {
    const best = pickBest(usable, conjunction, matches, targets, survivors);
    if (best === null) {
      return null;
    }
    conjunction.push(best);
    const match = matches.get(best)!;
    survivors = new Set([...survivors].filter(key => match.has(key)));
  }

  return setEquals(survivors, targets) ? conjunction : null;
}

function firstGreedyPick<B>(
  usable: Atom<B>[],
  matches: Map<Atom<B>, Set<number>>,
  targets: Set<number>,
  universe: Set<number>,
): Atom<B> | null {
  return pickBest(usable, [], matches, targets, universe);
}

function pickBest<B>(
  usable: Atom<B>[],
  conjunction: Atom<B>[],
  matches: Map<Atom<B>, Set<number>>,
  targets: Set<number>,
  survivors: Set<number>,
): Atom<B> | null {
  let best: Atom<B> | null = null;
  let bestEliminated = 0;
  for (const atom of usable) {
    if (conjunction.includes(atom)) {
      continue;
    }
    const match = matches.get(atom)!;
    let eliminated = 0;
    for (const key of survivors) {
      if (!match.has(key) && !targets.has(key)) {
        eliminated++;
      }
    }
    if (eliminated === 0) {
      continue;
    }
    if (best === null || eliminated > bestEliminated
      || (eliminated === bestEliminated && preferAtom(atom, best))) {
      best = atom;
      bestEliminated = eliminated;
    }
  }
  return best;
}

/** Tie-break: robustness weight, then fewer constants, then shorter code. */
function preferAtom<B>(candidate: Atom<B>, incumbent: Atom<B>): boolean {
  if (candidate.weight !== incumbent.weight) {
    return candidate.weight > incumbent.weight;
  }
  if (candidate.constants !== incumbent.constants) {
    return candidate.constants < incumbent.constants;
  }
  return candidate.code.length < incumbent.code.length;
}

function setEquals(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const key of a) {
    if (!b.has(key)) {
      return false;
    }
  }
  return true;
}

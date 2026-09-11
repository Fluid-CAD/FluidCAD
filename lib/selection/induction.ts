import { Atom } from "./atoms.js";

/**
 * Oracle for contextual (set-level) atoms: the keys a conjunction extended
 * by `atom` resolves to over the universe. Called during induction because a
 * contextual atom's match set depends on the candidates the conjunction has
 * already narrowed the universe to.
 */
export type ContextualEvaluator<B> = (conjunction: Atom<B>[], atom: Atom<B>) => Set<number>;

/**
 * Greedy set-cover induction of a short filter conjunction (design §3.2):
 * pick the atom that eliminates the most non-target survivors, repeat until
 * only the targets survive or the conjunction stops being readable. The cap
 * is 4 rather than the design's ≈3 because isolating a repeat instance needs
 * an `above` + `below` bracket (2 atoms) on top of the shape predicates.
 *
 * Atoms without baked geometry constants get a pass of their own first: a
 * conjunction of qualitative/datum/rank predicates (or parameter-linked
 * constants) survives the dimension edits that silently break baked-in
 * numbers, so `edge().line().below('xz')` beats
 * `edge().onPlane('xz', -34.641...)` even though the latter needs fewer
 * atoms. Baked-constant atoms only enter when nothing robust resolves —
 * repeat-instance brackets, dimension-only distinctions.
 *
 * `matches` holds each per-shape atom's oracle-evaluated match set over the
 * universe (keyed the same way as `targets`/`universe`). Atoms that are not
 * true for every target are unusable — a conjunction containing one could
 * never resolve to the full picked set. Contextual atoms (`farthest`,
 * `largest`…) have no fixed match set: `evaluateContextual` resolves them
 * against the conjunction built so far at every step, and they are appended
 * in the order picked — the emitted chain evaluates stages in that same
 * order, so the induced semantics and the rendered code agree.
 */
export function induceConjunction<B>(
  atoms: Atom<B>[],
  matches: Map<Atom<B>, Set<number>>,
  targets: Set<number>,
  universe: Set<number>,
  maxAtoms = 4,
  evaluateContextual?: ContextualEvaluator<B>,
): Atom<B>[] | null {
  return induceConjunctions(atoms, matches, targets, universe, maxAtoms, evaluateContextual, 1)[0] ?? null;
}

/**
 * Ranked distinct conjunctions, best first: the constant-free pass's winner
 * and its restart variants (each with the previous winner's opener banned),
 * then the same over the full atom set. Every entry resolves to exactly the
 * targets; callers surface the runner-ups as UI alternatives.
 */
export function induceConjunctions<B>(
  atoms: Atom<B>[],
  matches: Map<Atom<B>, Set<number>>,
  targets: Set<number>,
  universe: Set<number>,
  maxAtoms = 4,
  evaluateContextual?: ContextualEvaluator<B>,
  limit = 3,
): Atom<B>[][] {
  const search = new InductionSearch(matches, targets, universe, evaluateContextual);
  const usable = atoms.filter(atom => {
    if (atom.contextual) {
      return evaluateContextual !== undefined;
    }
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

  const gather = (pool: Atom<B>[]) => [...search.variants(pool, maxAtoms, limit)];

  // The robust pass: atoms no dimension edit can silently break — no
  // constants, counts, or constants linked to a user parameter (the emitted
  // name follows the variable). Only unlinked geometry constants wait for
  // the full pass.
  const robust = usable.filter(atom => (atom.bakedConstants ?? 0) === 0);
  const robustResults = robust.length < usable.length ? gather(robust) : [];
  // The descriptive-only form — what per-shape predicates alone say, often
  // the explicit `onPlane('xz', -50)` or `cylinder(14)` a user may prefer to
  // edit or link to a parameter — keeps a slot in the alternatives even when
  // rank forms fill the rest.
  const classic = usable.filter(atom => !atom.contextual);
  const classicResults = classic.length < usable.length ? gather(classic) : [];
  const fullResults = gather(usable);

  const results: Atom<B>[][] = [];
  const seen = new Set<string>();
  const add = (conjunction: Atom<B>[]) => {
    const key = conjunction.map(a => a.code).join('');
    if (!seen.has(key) && results.length < limit) {
      seen.add(key);
      results.push(conjunction);
    }
  };
  for (const conjunction of robustResults.slice(0, Math.max(1, limit - 1))) {
    add(conjunction);
  }
  if (classicResults.length > 0) {
    add(classicResults[0]);
  }
  if (fullResults.length > 0) {
    add(fullResults[0]);
  }
  for (const conjunction of [...robustResults, ...classicResults, ...fullResults]) {
    add(conjunction);
  }
  return results;
}

/** Contextual atoms below this weight (`nth`) never close a conjunction outright. */
const LAST_RESORT_WEIGHT = 15;

class InductionSearch<B> {
  private contextualCache = new Map<string, Set<number> | null>();

  constructor(
    private matches: Map<Atom<B>, Set<number>>,
    private targets: Set<number>,
    private universe: Set<number>,
    private evaluateContextual?: ContextualEvaluator<B>,
  ) {}

  /**
   * Greedy is myopic: a high-weight opener can burn the atom budget on a
   * path with no finish. Retry with the failed attempt's opener banned —
   * restarts are cheap (match sets are precomputed) and recover most misses.
   * Successful attempts ban their opener too, so the walk yields the
   * distinct runner-ups the UI offers as alternatives.
   */
  *variants(pool: Atom<B>[], maxAtoms: number, limit: number): Generator<Atom<B>[]> {
    const banned = new Set<Atom<B>>();
    let found = 0;
    for (let attempt = 0; attempt <= 3 && found < limit; attempt++) {
      const candidates = pool.filter(atom => !banned.has(atom));
      const conjunction = this.greedyCover(candidates, maxAtoms);
      if (conjunction !== null) {
        found++;
        banned.add(conjunction[0]);
        yield conjunction;
        continue;
      }
      const opener = this.pickBest(candidates, [], this.universe);
      if (opener === null) {
        return;
      }
      banned.add(opener);
    }
  }

  private greedyCover(usable: Atom<B>[], maxAtoms: number): Atom<B>[] | null {
    let survivors = new Set(this.universe);
    const conjunction: Atom<B>[] = [];

    while (!setEquals(survivors, this.targets) && conjunction.length < maxAtoms) {
      const best = this.pickBest(usable, conjunction, survivors);
      if (best === null) {
        return null;
      }
      const match = this.matchOf(best, conjunction)!;
      conjunction.push(best);
      survivors = new Set([...survivors].filter(key => match.has(key)));
    }

    return setEquals(survivors, this.targets) ? conjunction : null;
  }

  /**
   * Next atom for the conjunction. Anything that finishes the job wins
   * outright (best weight among closers). Otherwise descriptive per-shape
   * atoms take priority — by non-targets eliminated, weight breaking ties —
   * and a contextual atom only fills in when no descriptive atom makes
   * progress, weight first: rank predicates eliminate aggressively, and
   * letting them open (or letting a layer index close early) turns "the arc
   * on the top face nearest the corner" into an opaque "second layer along
   * x". Last-resort contextual atoms (`nth`, weight below 15) never close
   * outright; they are reached only through that fill-in path.
   */
  private pickBest(usable: Atom<B>[], conjunction: Atom<B>[], survivors: Set<number>): Atom<B> | null {
    let closer: Atom<B> | null = null;
    let descriptive: Atom<B> | null = null;
    let descriptiveEliminated = 0;
    let contextual: Atom<B> | null = null;
    let contextualEliminated = 0;
    const nonTargets = [...survivors].filter(key => !this.targets.has(key)).length;

    for (const atom of usable) {
      if (conjunction.includes(atom)) {
        continue;
      }
      if (atom.contextual && (atom.minDepth ?? 0) > conjunction.length) {
        continue;
      }
      const match = this.matchOf(atom, conjunction);
      if (match === null) {
        continue;
      }
      let eliminated = 0;
      for (const key of survivors) {
        if (!match.has(key) && !this.targets.has(key)) {
          eliminated++;
        }
      }
      if (eliminated === 0) {
        continue;
      }
      const lastResort = atom.contextual && atom.weight < LAST_RESORT_WEIGHT;
      if (eliminated === nonTargets && !lastResort) {
        if (closer === null || preferAtom(atom, closer)) {
          closer = atom;
        }
        continue;
      }
      if (atom.contextual) {
        if (contextual === null || atom.weight > contextual.weight
          || (atom.weight === contextual.weight && (eliminated > contextualEliminated
            || (eliminated === contextualEliminated && preferAtom(atom, contextual))))) {
          contextual = atom;
          contextualEliminated = eliminated;
        }
      } else if (descriptive === null || eliminated > descriptiveEliminated
        || (eliminated === descriptiveEliminated && preferAtom(atom, descriptive))) {
        descriptive = atom;
        descriptiveEliminated = eliminated;
      }
    }
    return closer ?? descriptive ?? contextual;
  }

  /**
   * The atom's match set in the current context: precomputed for per-shape
   * atoms; for contextual atoms, evaluated (and memoized) against the
   * conjunction so far, and null when the result would drop a target.
   */
  private matchOf(atom: Atom<B>, conjunction: Atom<B>[]): Set<number> | null {
    if (!atom.contextual) {
      return this.matches.get(atom) ?? null;
    }
    const key = conjunction.map(a => a.code).join('') + '|' + atom.code;
    if (this.contextualCache.has(key)) {
      return this.contextualCache.get(key)!;
    }
    let match: Set<number> | null = this.evaluateContextual!(conjunction, atom);
    for (const target of this.targets) {
      if (!match.has(target)) {
        match = null;
        break;
      }
    }
    this.contextualCache.set(key, match);
    return match;
  }
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

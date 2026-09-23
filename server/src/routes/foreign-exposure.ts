import { readFile } from 'fs/promises';
import type { FluidCadServer } from '../fluidcad-server/index.ts';
import {
  resolvePartBindingIdent,
  type ApplyFeatureEditSpec,
  type ForeignExposureRef,
} from '../apply-feature-edit/index.ts';
import { relativeSpecifier } from './part-catalog.ts';
import { normalizePath } from '../normalize-path.ts';

export type Pick = { shapeId: string; sub: { type: 'edge' | 'face'; index: number } };
export type PickChain = { seed: Pick; members: Pick[] };

/** A `part()` statement as the scene captured it — the consumer of a cross-part reference. */
export type PartSite = { filePath: string; line: number; column: number };

/** One pick another part owns, as the response describes it to the dialog. */
export type ForeignPickSummary = {
  shapeId: string;
  sub: Pick['sub'];
  partName: string;
  exposeName: string;
  /** True when the donor already exposes the geometry; false when Apply creates the exposure. */
  existing: boolean;
};

export type ForeignPickResolution =
  | {
    ok: true;
    /** Picks the consumer owns (or that lie outside every part): the ordinary synthesis input. */
    local: Pick[];
    /** The chains whose every member stayed local; a chain touching another part dissolves into plain picks. */
    chains: PickChain[];
    /** One reference per distinct exposure, in first-pick order. */
    refs: ForeignExposureRef[];
    /** The rendered reference expressions, parallel to `refs`. */
    expressions: string[];
    /** Every foreign pick, for the response's notice. */
    picks: ForeignPickSummary[];
    /** Cross-file expose creates — the caller dispatches these to the donor files first. */
    crossFileCreates: ApplyFeatureEditSpec[];
  }
  | { ok: false; status: 404 | 422; reason: string; pick?: Pick };

/** First `g<n>` not taken by an existing exposure — the tool's default names. */
export function allocateExposeName(taken: string[]): string {
  const set = new Set(taken);
  for (let i = 1; ; i++) {
    const candidate = `g${i}`;
    if (!set.has(candidate)) {
      return candidate;
    }
  }
}

type Donor = {
  partName: string;
  filePath: string;
  line: number;
  column: number;
  matched: string | null;
  existingNames: string[];
};

type ResolvedDonor = {
  donor: Donor;
  sameFile: boolean;
  ident: string;
  importFrom: string | null;
  /** Names taken on this donor: its existing exposures plus the ones allocated in this batch. */
  taken: string[];
};

/**
 * The consumer side of a cross-part pick: which picks belong to a part OTHER
 * than the statement's own, and the find-or-create reference for each — an
 * existing exposure that already serves the geometry, or a fresh `expose()`
 * synthesized in the donor (the Phase-B rail). Shared by the sketch-on-face
 * and the projection arms; read-only over the scene and the code buffers,
 * the caller dispatches what comes back.
 */
export class ForeignPickResolver {
  constructor(
    private readonly server: FluidCadServer,
    private readonly synthesisOptionsForFile: (filePath: string | null | undefined) => Promise<object | undefined>,
  ) {}

  /** Whether a pick's donor site IS the consumer's own part. */
  static sameSite(a: PartSite, b: PartSite): boolean {
    return a.line === b.line && a.column === b.column
      && normalizePath(a.filePath) === normalizePath(b.filePath);
  }

  /**
   * Split the picks by owner without synthesizing anything: the parts other
   * than `consumer` that own picks, by name. Empty when every pick is the
   * consumer's own (or the workspace kernel predates the lookup).
   */
  async classify(picks: Pick[], consumer: PartSite): Promise<
    | { ok: true; foreign: { pick: Pick; donor: Donor }[] }
    | { ok: false; status: 422; reason: string; pick?: Pick }
  > {
    const foreign: { pick: Pick; donor: Donor }[] = [];
    for (const pick of picks) {
      const resolution = this.server.resolvePickExposure?.(pick);
      if (!resolution) {
        continue;
      }
      if (resolution.ok === false) {
        return { ok: false, status: 422, reason: resolution.reason, pick };
      }
      const donor: Donor | null = resolution.donor ?? null;
      if (donor && !ForeignPickResolver.sameSite(donor, consumer)) {
        foreign.push({ pick, donor });
      }
    }
    return { ok: true, foreign };
  }

  /** Resolve every pick: the consumer's own stay as they are, the others become references. */
  async resolve(picks: Pick[], chains: PickChain[], consumer: PartSite): Promise<ForeignPickResolution> {
    const classified = await this.classify(picks, consumer);
    if (classified.ok === false) {
      return classified;
    }
    const foreignKeys = new Set(classified.foreign.map(f => pickKey(f.pick)));
    const local = picks.filter(p => !foreignKeys.has(pickKey(p)));
    if (classified.foreign.length === 0) {
      return { ok: true, local, chains, refs: [], expressions: [], picks: [], crossFileCreates: [] };
    }
    // A chain synthesizes to one `.withTangents()` selector on its owner; an
    // exposure publishes a single face or edge. A chain touching another
    // part dissolves — its members were already in `picks` — so each member
    // is exposed on its own.
    const keptChains = chains.filter(c => c.members.every(m => !foreignKeys.has(pickKey(m))));

    const donors = new Map<string, ResolvedDonor>();
    const refs: ForeignExposureRef[] = [];
    const expressions: string[] = [];
    const summaries: ForeignPickSummary[] = [];
    const crossFileCreates: ApplyFeatureEditSpec[] = [];
    const seen = new Set<string>();
    for (const { pick, donor } of classified.foreign) {
      const key = `${normalizePath(donor.filePath)}:${donor.line}:${donor.column}`;
      let resolved = donors.get(key);
      if (!resolved) {
        const outcome = await this.resolveDonor(donor, consumer);
        if ('error' in outcome) {
          return { ok: false, status: 422, reason: outcome.error, pick };
        }
        resolved = outcome;
        donors.set(key, resolved);
      }
      const existing = donor.matched !== null;
      const name = donor.matched ?? allocateExposeName(resolved.taken);
      summaries.push({ shapeId: pick.shapeId, sub: pick.sub, partName: donor.partName, exposeName: name, existing });
      if (seen.has(`${key}/${name}`)) {
        // Two picks served by the same exposure reference it once.
        continue;
      }
      seen.add(`${key}/${name}`);
      let create: ApplyFeatureEditSpec | null = null;
      if (!existing) {
        resolved.taken.push(name);
        const synthesized = await this.synthesizeCreate(pick, name);
        if ('error' in synthesized) {
          return { ok: false, status: synthesized.status, reason: synthesized.error, pick: synthesized.pick ?? pick };
        }
        create = synthesized.spec;
      }
      if (resolved.sameFile) {
        refs.push({
          exposeName: name,
          donor: { line: donor.line, column: donor.column },
          ...(create ? { create } : {}),
        });
      } else {
        refs.push({ exposeName: name, ident: resolved.ident, importFrom: resolved.importFrom! });
        if (create) {
          crossFileCreates.push(create);
        }
      }
      expressions.push(`${resolved.ident}.features.${name}`);
    }
    return { ok: true, local, chains: keptChains, refs, expressions, picks: summaries, crossFileCreates };
  }

  /**
   * The identifier the reference renders: the donor's module-level binding
   * (same file, read off the live buffer) or its export identifier plus an
   * import (cross-file, resolved from the donor file on disk).
   */
  private async resolveDonor(donor: Donor, consumer: PartSite): Promise<ResolvedDonor | { error: string }> {
    const sameFile = normalizePath(donor.filePath) === normalizePath(consumer.filePath);
    const taken = (donor.existingNames ?? []).slice();
    if (sameFile) {
      const code = this.server.getCurrentCode();
      if (code === null) {
        return { error: 'No live code buffer' };
      }
      const binding = await resolvePartBindingIdent(code, donor.line);
      if ('error' in binding) {
        return binding;
      }
      return { donor, sameFile, ident: binding.ident, importFrom: null, taken };
    }
    let donorCode: string;
    try {
      donorCode = await readFile(donor.filePath, 'utf8');
    } catch {
      return { error: `could not read the donor part's file (${donor.filePath})` };
    }
    const binding = await resolvePartBindingIdent(donorCode, donor.line);
    if ('error' in binding) {
      return binding;
    }
    if (!binding.exported) {
      return {
        error: `the part "${donor.partName}" is not exported from its file — export the binding `
          + `(export const ${binding.ident} = part(...)) so it can be imported here`,
      };
    }
    return {
      donor,
      sameFile,
      ident: binding.ident,
      importFrom: relativeSpecifier(consumer.filePath, donor.filePath),
      taken,
    };
  }

  /**
   * The donor-side `expose()` create for an unmatched pick: the expose arm's
   * two-pass synthesis — a probe to learn the file the statement lands in,
   * then the real pass with that file's namer and params.
   */
  private async synthesizeCreate(
    pick: Pick,
    name: string,
  ): Promise<{ spec: ApplyFeatureEditSpec } | { status: 404 | 422; error: string; pick?: Pick }> {
    const probe = this.server.synthesizeApplyFeature([pick], 'expose', name, []);
    if (!probe) {
      return { status: 404, error: 'No rendered scene' };
    }
    if (!probe.ok) {
      return { status: 422, error: probe.reason, pick: probe.pick };
    }
    const fileOptions = await this.synthesisOptionsForFile(probe.spec.filePath);
    const synth = fileOptions
      ? this.server.synthesizeApplyFeature([pick], 'expose', name, [], fileOptions)
      : probe;
    if (!synth) {
      return { status: 404, error: 'No rendered scene' };
    }
    if (!synth.ok) {
      return { status: 422, error: synth.reason, pick: synth.pick };
    }
    return { spec: synth.spec };
  }
}

function pickKey(pick: Pick): string {
  return `${pick.shapeId}/${pick.sub.type}/${pick.sub.index}`;
}

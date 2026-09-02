import type { LengthUnit } from '../units/units';

/** Minor / major grid pitch, in document units. */
export interface GridSpacing {
  minor: number;
  major: number;
}

export interface GridPrefs {
  /** Walk the unit's ladder with zoom (true) or pin `fixedSpacing` (false). */
  adaptive: boolean;
  /** Adaptive mode: the minor cell may not shrink below this many pixels. */
  minCellPx: number;
  /** Fixed mode: the minor pitch per document unit. */
  fixedSpacing: Record<LengthUnit, number>;
  /** Fixed mode: a major line every N minor cells. */
  majorEvery: number;
}

export const DEFAULT_GRID_FIXED_SPACING: Record<LengthUnit, number> = {
  mm: 10,
  cm: 1,
  m: 0.1,
  in: 0.5,
  ft: 0.25,
};

export const DEFAULT_GRID_MIN_CELL_PX = 20;
export const DEFAULT_GRID_MAJOR_EVERY = 10;

type Rung = { minor: number; major: number };

/**
 * Imperial ladders are hand-tuned tables rather than a formula: the "nice"
 * subdivisions of an inch are binary fractions, then 1 / 3 / 12 / 36 in
 * (inch, quarter-foot, foot, yard) with the majors landing on the next
 * customary unit. Metric is generated (1-2-5 per decade, major = 10×).
 */
const INCH_RUNGS: Rung[] = [
  { minor: 1 / 64, major: 1 / 16 },
  { minor: 1 / 32, major: 1 / 8 },
  { minor: 1 / 16, major: 1 / 4 },
  { minor: 1 / 8, major: 1 / 2 },
  { minor: 1 / 4, major: 1 },
  { minor: 1 / 2, major: 2 },
  { minor: 1, major: 12 },
  { minor: 3, major: 12 },
  { minor: 12, major: 120 },
  { minor: 36, major: 120 },
  { minor: 120, major: 600 },
  { minor: 600, major: 6000 },
];

const FOOT_RUNGS: Rung[] = [
  { minor: 1 / 12, major: 1 },
  { minor: 1 / 4, major: 1 },
  { minor: 1 / 2, major: 1 },
  { minor: 1, major: 10 },
  { minor: 5, major: 50 },
  { minor: 10, major: 100 },
  { minor: 50, major: 500 },
  { minor: 100, major: 1000 },
];

const METRIC_SEQUENCE = [1, 2, 5, 10];
/** Floating-point slack when comparing a rung against the pixel target. */
const RUNG_TOLERANCE = 1 - 1e-9;

/** Smallest 1-2-5 × 10ⁿ ≥ target, any decade. */
function metricRung(target: number): Rung {
  const decade = 10 ** Math.floor(Math.log10(target));
  for (const s of METRIC_SEQUENCE) {
    const minor = decade * s;
    if (minor >= target * RUNG_TOLERANCE) {
      return { minor, major: minor * 10 };
    }
  }
  // Unreachable: 10 × decade always clears the target.
  return { minor: decade * 10, major: decade * 100 };
}

/**
 * Smallest table rung ≥ target. Past the table's ends the ladder keeps
 * going: tenfold above (600 in → 6000 in → …, majors 10×) and halving
 * below (1/128 in, 1/256 in, … with the fraction rule major = 4 × minor),
 * so deep zoom always has a lattice to snap to.
 */
function tableRung(table: Rung[], target: number): Rung {
  const first = table[0];
  if (target <= first.minor * RUNG_TOLERANCE) {
    let minor = first.minor;
    while (minor / 2 >= target * RUNG_TOLERANCE) {
      minor /= 2;
    }
    return minor === first.minor ? first : { minor, major: minor * 4 };
  }
  for (const rung of table) {
    if (rung.minor >= target * RUNG_TOLERANCE) {
      return rung;
    }
  }
  let minor = table[table.length - 1].minor;
  while (minor < target * RUNG_TOLERANCE) {
    minor *= 10;
  }
  return { minor, major: minor * 10 };
}

function adaptiveRung(unit: LengthUnit, target: number): Rung {
  if (unit === 'in') {
    return tableRung(INCH_RUNGS, target);
  }
  if (unit === 'ft') {
    return tableRung(FOOT_RUNGS, target);
  }
  return metricRung(target);
}

function fixedSpacing(unit: LengthUnit, prefs: GridPrefs): GridSpacing {
  const configured = prefs.fixedSpacing[unit];
  const minor = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_GRID_FIXED_SPACING[unit];
  const every = Number.isFinite(prefs.majorEvery) && prefs.majorEvery >= 2
    ? Math.round(prefs.majorEvery)
    : DEFAULT_GRID_MAJOR_EVERY;
  return { minor, major: minor * every };
}

/**
 * The grid pitch for the current zoom — shared by the shader grid and the
 * grid snapper so the drawn and snapped lattices are the same lattice.
 * `worldUnitsPerPixel` is the zoom (document units per screen pixel).
 * Adaptive: the smallest rung whose minor cell is at least `minCellPx`
 * wide on screen. Fixed: the preference, regardless of zoom.
 */
export function resolveGridSpacing(unit: LengthUnit, worldUnitsPerPixel: number, prefs: GridPrefs): GridSpacing {
  if (!prefs.adaptive) {
    return fixedSpacing(unit, prefs);
  }
  const minCellPx = Number.isFinite(prefs.minCellPx) && prefs.minCellPx > 0 ? prefs.minCellPx : DEFAULT_GRID_MIN_CELL_PX;
  const target = minCellPx * worldUnitsPerPixel;
  if (!Number.isFinite(target) || target <= 0) {
    // No zoom yet (a canvas without a size): the fixed default keeps the
    // grid sane until the first camera update.
    return fixedSpacing(unit, { ...prefs, fixedSpacing: DEFAULT_GRID_FIXED_SPACING, majorEvery: DEFAULT_GRID_MAJOR_EVERY });
  }
  const rung = adaptiveRung(unit, target);
  return { minor: rung.minor, major: rung.major };
}

/** Denominators a rung can be read as a fraction of — binary, plus the
 * twelfths of a foot. */
const FRACTION_DENOMINATORS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 512, 1024, 2048, 4096];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function asFraction(value: number): string | null {
  for (const d of FRACTION_DENOMINATORS) {
    const n = value * d;
    const rounded = Math.round(n);
    if (rounded > 0 && Math.abs(n - rounded) < 1e-9) {
      const g = gcd(rounded, d);
      return `${rounded / g}/${d / g}`;
    }
  }
  return null;
}

/** Shortest exact-looking decimal: 0.1, 2, 0.001 — never "10.000000". */
function trimmed(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/**
 * A pitch as the scale bar spells it, without the unit: "10", "1/8", "0.2".
 * Imperial sub-unit rungs read as fractions (what the ladder is built from);
 * every other value is a trimmed decimal. Also what the chip's edit field
 * is seeded with, so a fraction round-trips as typed.
 */
export function formatGridPitch(spacing: number, unit: LengthUnit): string {
  if ((unit === 'in' || unit === 'ft') && spacing < 1) {
    const fraction = asFraction(spacing);
    if (fraction) {
      return fraction;
    }
  }
  return trimmed(spacing);
}

/** The scale-bar readout for a pitch: "10 mm", "1/8 in", "1 ft". */
export function formatGridLabel(spacing: number, unit: LengthUnit): string {
  return `${formatGridPitch(spacing, unit)} ${unit}`;
}

// Fastener hole standards the hole() feature and its dialog share: clearance
// diameters (ISO 273 / ASME B18.2.8), tap drills (ISO 262 coarse + fine, UNC /
// UNF), socket head cap screw counterbores (ISO 4762 / ASME B18.3 via DIN 974-1
// series 1) and flat head countersinks (ISO 10642 90° / ASME B18.3 82°). Pure
// data + lookups; no kernel imports so the UI bundle can use it too.

export type FastenerStandard = 'metric' | 'inch';
export type FastenerFit = 'close' | 'normal' | 'loose';

/** Every length below is in the standard's own unit: mm for metric, inches for inch. */
export interface FastenerSize {
  /** The size label the dialog shows and the statement writes: 'M6', '1/4', '#10'. */
  readonly label: string;
  /** Nominal (major) diameter. */
  readonly major: number;
  /** Clearance hole diameter per fit. */
  readonly clearance: Readonly<Record<FastenerFit, number>>;
  /** Thread pitches (mm) for metric, threads per inch for inch; the first entry is coarse. */
  readonly pitches: readonly number[];
  /** Tap drill diameter per pitch, same order as `pitches`. */
  readonly tapDrills: readonly number[];
  /** Counterbore for a socket head cap screw: diameter and depth. */
  readonly counterbore: { readonly diameter: number; readonly depth: number };
  /** Countersink for a flat head screw: diameter at the surface and included angle in degrees. */
  readonly countersink: { readonly diameter: number; readonly angle: number };
}

function metric(
  label: string,
  major: number,
  clearance: [number, number, number],
  pitches: number[],
  tapDrills: number[],
  counterbore: [number, number],
  countersink: number,
): FastenerSize {
  return {
    label,
    major,
    clearance: { close: clearance[0], normal: clearance[1], loose: clearance[2] },
    pitches,
    tapDrills,
    counterbore: { diameter: counterbore[0], depth: counterbore[1] },
    countersink: { diameter: countersink, angle: 90 },
  };
}

function inchSize(
  label: string,
  major: number,
  clearance: [number, number, number],
  pitches: number[],
  tapDrills: number[],
  counterbore: [number, number],
  countersink: number,
): FastenerSize {
  return {
    label,
    major,
    clearance: { close: clearance[0], normal: clearance[1], loose: clearance[2] },
    pitches,
    tapDrills,
    counterbore: { diameter: counterbore[0], depth: counterbore[1] },
    countersink: { diameter: countersink, angle: 82 },
  };
}

export const METRIC_SIZES: readonly FastenerSize[] = [
  metric('M1.6', 1.6, [1.7, 1.8, 2.0], [0.35], [1.25], [3.5, 1.8], 3.6),
  metric('M2', 2, [2.2, 2.4, 2.6], [0.4], [1.6], [4.4, 2.3], 4.4),
  metric('M2.5', 2.5, [2.7, 2.9, 3.1], [0.45], [2.05], [5.0, 2.9], 5.5),
  metric('M3', 3, [3.2, 3.4, 3.6], [0.5], [2.5], [6.5, 3.4], 6.72),
  metric('M4', 4, [4.3, 4.5, 4.8], [0.7], [3.3], [8.0, 4.6], 8.96),
  metric('M5', 5, [5.3, 5.5, 5.8], [0.8], [4.2], [10.0, 5.7], 11.2),
  metric('M6', 6, [6.4, 6.6, 7.0], [1.0, 0.75], [5.0, 5.25], [11.0, 6.8], 13.44),
  metric('M8', 8, [8.4, 9.0, 10.0], [1.25, 1.0], [6.8, 7.0], [15.0, 9.0], 17.92),
  metric('M10', 10, [10.5, 11.0, 12.0], [1.5, 1.25, 1.0], [8.5, 8.75, 9.0], [18.0, 11.0], 22.4),
  metric('M12', 12, [13.0, 13.5, 14.5], [1.75, 1.5, 1.25], [10.2, 10.5, 10.8], [20.0, 13.0], 26.88),
  metric('M14', 14, [15.0, 15.5, 16.5], [2.0, 1.5], [12.0, 12.5], [24.0, 15.0], 30.8),
  metric('M16', 16, [17.0, 17.5, 18.5], [2.0, 1.5], [14.0, 14.5], [26.0, 17.5], 33.6),
  metric('M20', 20, [21.0, 22.0, 24.0], [2.5, 2.0, 1.5], [17.5, 18.0, 18.5], [33.0, 21.5], 40.32),
  metric('M24', 24, [25.0, 26.0, 28.0], [3.0, 2.0], [21.0, 22.0], [40.0, 25.5], 48.0),
  metric('M30', 30, [31.0, 33.0, 35.0], [3.5, 2.0], [26.5, 28.0], [48.0, 32.0], 60.0),
  metric('M36', 36, [37.0, 39.0, 42.0], [4.0, 3.0], [32.0, 33.0], [57.0, 38.0], 72.0),
];

export const INCH_SIZES: readonly FastenerSize[] = [
  inchSize('#2', 0.086, [0.089, 0.0935, 0.1015], [56, 64], [0.07, 0.07], [0.1875, 0.086], 0.172),
  inchSize('#4', 0.112, [0.116, 0.12, 0.1285], [40, 48], [0.089, 0.0935], [0.2188, 0.112], 0.225),
  inchSize('#6', 0.138, [0.144, 0.1495, 0.157], [32, 40], [0.1065, 0.113], [0.2813, 0.138], 0.279),
  inchSize('#8', 0.164, [0.1695, 0.177, 0.1875], [32, 36], [0.136, 0.136], [0.3125, 0.164], 0.332),
  inchSize('#10', 0.19, [0.196, 0.201, 0.2188], [24, 32], [0.1495, 0.159], [0.375, 0.19], 0.385),
  inchSize('1/4', 0.25, [0.257, 0.266, 0.2813], [20, 28], [0.201, 0.213], [0.4375, 0.25], 0.507),
  inchSize('5/16', 0.3125, [0.323, 0.332, 0.3438], [18, 24], [0.257, 0.272], [0.5313, 0.3125], 0.635),
  inchSize('3/8', 0.375, [0.386, 0.397, 0.4063], [16, 24], [0.3125, 0.332], [0.625, 0.375], 0.762),
  inchSize('7/16', 0.4375, [0.4531, 0.4688, 0.4844], [14, 20], [0.368, 0.3906], [0.7188, 0.4375], 0.812),
  inchSize('1/2', 0.5, [0.5156, 0.5313, 0.5625], [13, 20], [0.4219, 0.4531], [0.8125, 0.5], 0.875),
  inchSize('5/8', 0.625, [0.6406, 0.6563, 0.6875], [11, 18], [0.5313, 0.5781], [1.0, 0.625], 1.0),
  inchSize('3/4', 0.75, [0.7656, 0.7813, 0.8125], [10, 16], [0.6563, 0.6875], [1.1875, 0.75], 1.25),
  inchSize('1', 1.0, [1.0156, 1.0313, 1.0625], [8, 12], [0.875, 0.9219], [1.5625, 1.0], 1.625),
];

/** The unit a standard's table values are written in. */
export const FASTENER_TABLE_UNIT: Record<FastenerStandard, 'mm' | 'in'> = { metric: 'mm', inch: 'in' };

export const FASTENER_SIZES: Record<FastenerStandard, readonly FastenerSize[]> = {
  metric: METRIC_SIZES,
  inch: INCH_SIZES,
};

/** The standard a size label belongs to: `M…` is metric, everything else inch. */
export function fastenerStandardOf(label: string): FastenerStandard {
  return /^m/i.test(label.trim()) ? 'metric' : 'inch';
}

/** Normalise a size label the way the tables spell it (`m6` → `M6`, ` #10 ` → `#10`). */
export function normalizeFastenerLabel(label: string): string {
  const trimmed = label.trim();
  return fastenerStandardOf(trimmed) === 'metric' ? `M${trimmed.slice(1)}` : trimmed;
}

/** The table row for a size label, or null when no standard lists it. */
export function findFastenerSize(label: string): { standard: FastenerStandard; size: FastenerSize } | null {
  const standard = fastenerStandardOf(label);
  const wanted = normalizeFastenerLabel(label);
  const size = FASTENER_SIZES[standard].find(row => row.label === wanted);
  return size ? { standard, size } : null;
}

/** The tap drill for a pitch, or null when the size has no such pitch. `null` pitch = coarse (the first). */
export function tapDrillFor(size: FastenerSize, pitch: number | null): { pitch: number; tapDrill: number } | null {
  const index = pitch === null ? 0 : size.pitches.findIndex(p => Math.abs(p - pitch) < 1e-9);
  if (index < 0) {
    return null;
  }
  return { pitch: size.pitches[index], tapDrill: size.tapDrills[index] };
}

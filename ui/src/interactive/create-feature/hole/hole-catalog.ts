// The fastener catalog the Hole dialog reads: which sizes, fits and pitches a
// standard offers, and what the tables say for a choice — converted into the
// document's unit, because the dialog's fields and the statement's explicit
// numbers are always in the file's unit while the tables are in the
// standard's own (mm for metric, inches for inch).

import {
  FASTENER_SIZES,
  FASTENER_TABLE_UNIT,
  findFastenerSize,
  tapDrillFor,
  type FastenerFit,
  type FastenerSize,
  type FastenerStandard,
} from '../../../../../lib/features/hole/fastener-tables.js';
import { convertLength, roundToUnitDecimals, type LengthUnit } from '../../../units/units';
import { sceneUnit } from '../../../units/scene-unit';

export type { FastenerFit, FastenerStandard };

export type HoleType = 'drilled' | 'clearance' | 'tapped';

export const FASTENER_FITS: { value: FastenerFit; label: string }[] = [
  { value: 'close', label: 'Close' },
  { value: 'normal', label: 'Normal' },
  { value: 'loose', label: 'Loose' },
];

/** The size labels a standard lists, in table order. */
export function sizeLabels(standard: FastenerStandard): string[] {
  return FASTENER_SIZES[standard].map(size => size.label);
}

/** The pitches a size offers, coarse first, labelled the way the dialog shows them. */
export function pitchOptions(label: string): { value: number; label: string }[] {
  const found = findFastenerSize(label);
  if (!found) {
    return [];
  }
  const unit = found.standard === 'metric' ? 'mm' : 'tpi';
  return found.size.pitches.map((pitch, index) => ({
    value: pitch,
    label: `${pitch} ${unit}${index === 0 ? ' (coarse)' : ' (fine)'}`,
  }));
}

/** The standard a size label belongs to, or `fallback` when the tables don't list it. */
export function standardOf(label: string | null, fallback: FastenerStandard = 'metric'): FastenerStandard {
  const found = label === null ? null : findFastenerSize(label);
  return found ? found.standard : fallback;
}

/** A table value expressed in the document unit, rounded to what the unit displays. */
function inDocumentUnit(value: number, standard: FastenerStandard, unit: LengthUnit): number {
  return roundToUnitDecimals(convertLength(value, FASTENER_TABLE_UNIT[standard], unit), unit);
}

function sizeRow(label: string): { standard: FastenerStandard; size: FastenerSize } | null {
  return findFastenerSize(label);
}

/**
 * The diameter the tables give a size for a hole type: the clearance
 * diameter of the fit, or the tap drill of the pitch (null = coarse). Null
 * for a drilled hole (the user types it) or an unknown size/pitch.
 */
export function tableDiameter(
  label: string,
  type: HoleType,
  choice: { fit?: FastenerFit; pitch?: number | null },
  unit: LengthUnit = sceneUnit.current,
): number | null {
  const row = sizeRow(label);
  if (!row || type === 'drilled') {
    return null;
  }
  if (type === 'clearance') {
    return inDocumentUnit(row.size.clearance[choice.fit ?? 'normal'], row.standard, unit);
  }
  const tap = tapDrillFor(row.size, choice.pitch ?? null);
  return tap ? inDocumentUnit(tap.tapDrill, row.standard, unit) : null;
}

/** The socket-head counterbore the tables give a size, in the document unit; null for an unknown size. */
export function tableCounterbore(
  label: string,
  unit: LengthUnit = sceneUnit.current,
): { diameter: number; depth: number } | null {
  const row = sizeRow(label);
  if (!row) {
    return null;
  }
  return {
    diameter: inDocumentUnit(row.size.counterbore.diameter, row.standard, unit),
    depth: inDocumentUnit(row.size.counterbore.depth, row.standard, unit),
  };
}

/** The flat-head countersink the tables give a size (diameter in the document unit, angle in degrees). */
export function tableCountersink(
  label: string,
  unit: LengthUnit = sceneUnit.current,
): { diameter: number; angle: number } | null {
  const row = sizeRow(label);
  if (!row) {
    return null;
  }
  return {
    diameter: inDocumentUnit(row.size.countersink.diameter, row.standard, unit),
    angle: row.size.countersink.angle,
  };
}

/** The coarse pitch of a size — what `.tapped()` without a value means. */
export function coarsePitch(label: string): number | null {
  const row = sizeRow(label);
  return row ? row.size.pitches[0] : null;
}

/** A sensible drilled diameter to start from when the dialog opens: 6 mm in the document unit. */
export function defaultDrilledDiameter(unit: LengthUnit = sceneUnit.current): number {
  return roundToUnitDecimals(convertLength(6, 'mm', unit), unit);
}

/** The catalog's first size of a standard (M6 / 1/4). */
export function defaultSizeLabel(standard: FastenerStandard): string {
  return standard === 'metric' ? 'M6' : '1/4';
}

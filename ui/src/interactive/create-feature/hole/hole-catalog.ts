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

/** The groups the size dropdown lists, metric first. */
export const SIZE_GROUPS: { standard: FastenerStandard; label: string }[] = [
  { standard: 'metric', label: 'Metric' },
  { standard: 'inch', label: 'Imperial' },
];

/** The size the dialog opens on. */
export const DEFAULT_SIZE_LABEL = 'M6';

/** The size labels a standard lists, in table order. */
export function sizeLabels(standard: FastenerStandard): string[] {
  return FASTENER_SIZES[standard].map(size => size.label);
}

/** The pitches a size offers, grouped coarse then fine, each labelled with its unit; empty groups are left out. */
export function pitchGroups(label: string): { label: string; pitches: { value: number; label: string }[] }[] {
  const found = findFastenerSize(label);
  if (!found) {
    return [];
  }
  const unit = found.standard === 'metric' ? 'mm' : 'tpi';
  const options = found.size.pitches.map(pitch => ({ value: pitch, label: `${pitch} ${unit}` }));
  return [
    { label: 'Coarse', pitches: options.slice(0, 1) },
    { label: 'Fine', pitches: options.slice(1) },
  ].filter(group => group.pitches.length > 0);
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

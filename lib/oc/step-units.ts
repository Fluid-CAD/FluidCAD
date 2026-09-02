// Reads the unit declarations out of a STEP file's text.
//
// OCCT's STEPControl_Reader.FileUnits() is bound, but it fills an
// NCollection_Sequence_TCollection_AsciiString whose Value() cannot be called
// from JS (TCollection_AsciiString is not bound), so the names never reach us.
// The header is plain text with a fixed grammar, so we read it directly:
//
//   #346 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );
//   #12  = ( CONVERSION_BASED_UNIT('INCH',#13) LENGTH_UNIT() NAMED_UNIT(#14) );
//   #347 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );
//
// Names follow OCCT's own FileUnits() spelling (MILLIMETRE, INCH, RADIAN, ...)
// so a future binding that exposes the strings can swap in without changing
// the sidecar format.

import type { LengthUnit } from "../units/units.js";

export type StepFileUnits = {
  /** Length unit names in order of appearance, deduplicated. */
  length: string[];
  /** Plane-angle unit names in order of appearance, deduplicated. */
  angle: string[];
};

const SI_PREFIX_NAMES: Record<string, string> = {
  EXA: 'EXA', PETA: 'PETA', TERA: 'TERA', GIGA: 'GIGA', MEGA: 'MEGA', KILO: 'KILO',
  HECTO: 'HECTO', DECA: 'DECA', DECI: 'DECI', CENTI: 'CENTI', MILLI: 'MILLI',
  MICRO: 'MICRO', NANO: 'NANO', PICO: 'PICO', FEMTO: 'FEMTO', ATTO: 'ATTO',
};

/** STEP length-unit name → FluidCAD unit, or null when the name is not one we model. */
export function stepLengthUnitToLengthUnit(name: string): LengthUnit | null {
  switch (name.toUpperCase()) {
    case 'MILLIMETRE':
    case 'MILLIMETER':
      return 'mm';
    case 'CENTIMETRE':
    case 'CENTIMETER':
      return 'cm';
    case 'METRE':
    case 'METER':
      return 'm';
    case 'INCH':
      return 'in';
    case 'FOOT':
    case 'FEET':
      return 'ft';
    default:
      return null;
  }
}

function unitNameOf(entity: string): string | null {
  const conversion = /CONVERSION_BASED_UNIT\s*\(\s*'([^']*)'/i.exec(entity);
  if (conversion) {
    return conversion[1].toUpperCase();
  }
  const si = /SI_UNIT\s*\(\s*(\$|\.([A-Z]+)\.)\s*,\s*\.([A-Z]+)\.\s*\)/i.exec(entity);
  if (si) {
    const prefix = si[2] ? (SI_PREFIX_NAMES[si[2].toUpperCase()] ?? si[2].toUpperCase()) : '';
    return `${prefix}${si[3].toUpperCase()}`;
  }
  return null;
}

function pushUnique(list: string[], name: string | null): void {
  if (name && !list.includes(name)) {
    list.push(name);
  }
}

/** The length and plane-angle unit names a STEP file declares (empty when it declares none). */
export function parseStepFileUnits(text: string): StepFileUnits {
  const units: StepFileUnits = { length: [], angle: [] };
  const dataStart = text.indexOf('DATA;');
  const body = dataStart >= 0 ? text.slice(dataStart) : text;
  // Entities end at ';' and may wrap across lines; only the unit ones matter.
  for (const raw of body.split(';')) {
    if (!/_UNIT\s*\(/.test(raw)) {
      continue;
    }
    const entity = raw.replace(/\s+/g, ' ');
    if (/LENGTH_UNIT\s*\(\s*\)/.test(entity)) {
      pushUnique(units.length, unitNameOf(entity));
    } else if (/PLANE_ANGLE_UNIT\s*\(\s*\)/.test(entity)) {
      pushUnique(units.angle, unitNameOf(entity));
    }
  }
  return units;
}

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in';
export type AngleUnit = 'deg' | 'rad';

export const LENGTH_UNITS: { value: LengthUnit; label: string }[] = [
  { value: 'mm', label: 'Millimeter' },
  { value: 'cm', label: 'Centimeter' },
  { value: 'm', label: 'Meter' },
  { value: 'in', label: 'Inch' },
];

export const ANGLE_UNITS: { value: AngleUnit; label: string }[] = [
  { value: 'deg', label: 'Degree' },
  { value: 'rad', label: 'Radian' },
];

const LENGTH_FACTORS: Record<LengthUnit, number> = {
  mm: 1,
  cm: 0.1,
  m: 0.001,
  in: 1 / 25.4,
};

const LENGTH_DECIMALS: Record<LengthUnit, number> = {
  mm: 2,
  cm: 3,
  m: 5,
  in: 3,
};

export function convertLength(mm: number, unit: LengthUnit): number {
  return mm * LENGTH_FACTORS[unit];
}

export function formatLength(mm: number, unit: LengthUnit): string {
  return `${convertLength(mm, unit).toFixed(LENGTH_DECIMALS[unit])} ${unit}`;
}

export function formatArea(mm2: number, unit: LengthUnit): string {
  const factor = LENGTH_FACTORS[unit];
  return `${(mm2 * factor * factor).toFixed(LENGTH_DECIMALS[unit])} ${unit}²`;
}

export function formatAngle(deg: number, unit: AngleUnit): string {
  if (unit === 'rad') {
    return `${(deg * (Math.PI / 180)).toFixed(4)} rad`;
  }
  return `${deg.toFixed(2)} deg`;
}

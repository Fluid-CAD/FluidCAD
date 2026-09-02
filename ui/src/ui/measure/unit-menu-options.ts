import type { SceneDocument } from '../../units/scene-document';
import type { LengthUnit } from '../../units/units';

/** The units the chip always offers; the current one joins them if it is another. */
const OFFERED_UNITS: LengthUnit[] = ['mm', 'in'];

export type UnitMenuOption = {
  label: string;
  /** What picking it writes: a unit to declare, or null to follow the project unit. */
  unit: LengthUnit | null;
  /** The entry that describes the document as it is now. */
  current: boolean;
};

/**
 * The rows of the unit chip's dropup for the document on screen.
 *
 * An assembly is measured in the project unit, so its rows are the units
 * themselves with the current one checked. A part gets "Same as project"
 * first — labelled with the live project unit, checked when the file
 * declares nothing — then the units, checked on the declared one. Picking a
 * unit that equals the project unit still declares it explicitly: explicit
 * is explicit, and "Same as project" is the way to un-declare. `unit` is
 * what the scene reports (declared, else project), which is what an
 * assembly checks and what keeps an unusual unit visible in the list.
 */
export function buildUnitMenuOptions(
  doc: Pick<SceneDocument, 'kind' | 'declaredUnit' | 'projectUnit'>,
  unit: LengthUnit,
): UnitMenuOption[] {
  const units: LengthUnit[] = OFFERED_UNITS.includes(unit) ? OFFERED_UNITS : [...OFFERED_UNITS, unit];
  if (doc.kind === 'assembly') {
    return units.map((u) => ({ label: u, unit: u, current: u === unit }));
  }
  return [
    { label: `Same as project (${doc.projectUnit})`, unit: null, current: doc.declaredUnit === null },
    ...units.map((u) => ({ label: u, unit: u, current: u === doc.declaredUnit })),
  ];
}

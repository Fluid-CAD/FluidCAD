import type { SceneDocument } from '../../units/scene-document';
import { LENGTH_UNITS } from '../../units/units';
import type { LengthUnit } from '../../units/units';

export type UnitMenuOption = {
  label: string;
  /** Tooltip: the unit's long name, since the row shows only its code. */
  title?: string;
  /** What picking it writes: a unit to declare, or null to follow the project unit. */
  unit: LengthUnit | null;
  /** The entry that describes the document as it is now. */
  current: boolean;
};

/**
 * The rows of the unit chip's dropup for the document on screen.
 *
 * Every supported unit is offered, in `LENGTH_UNITS` order. An assembly is
 * measured in the project unit, so its rows are the units themselves with
 * the current one checked. A part gets "Same as project" first — labelled
 * with the live project unit, checked when the file declares nothing — then
 * the units, checked on the declared one. Picking a unit that equals the
 * project unit still declares it explicitly: explicit is explicit, and
 * "Same as project" is the way to un-declare. `unit` is what the scene
 * reports (declared, else project), which is what an assembly checks.
 */
export function buildUnitMenuOptions(
  doc: Pick<SceneDocument, 'kind' | 'declaredUnit' | 'projectUnit'>,
  unit: LengthUnit,
): UnitMenuOption[] {
  const checked = doc.kind === 'assembly' ? unit : doc.declaredUnit;
  const units = LENGTH_UNITS.map((u) => ({ label: u.value, title: u.label, unit: u.value, current: u.value === checked }));
  if (doc.kind === 'assembly') {
    return units;
  }
  return [
    { label: `Same as project (${doc.projectUnit})`, unit: null, current: doc.declaredUnit === null },
    ...units,
  ];
}

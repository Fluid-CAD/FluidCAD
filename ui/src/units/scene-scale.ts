import { MM_PER_UNIT } from './units';
import { sceneUnit } from './scene-unit';

/**
 * Scene-scale constants were tuned for millimetre documents (a 120 mm
 * default view, a 50 mm sketch camera stand-off, 1e-3 mm coincidence
 * epsilons…). A document's numbers ARE its unit (plan §2), so the same
 * visual intent in an inch or metre document is that many millimetres
 * expressed in the document unit. Evaluate at use time — the unit changes
 * between renders of different files, so nothing may bake this into a
 * module-load constant.
 */
export function worldFromMm(mm: number): number {
  return mm / MM_PER_UNIT[sceneUnit.current];
}

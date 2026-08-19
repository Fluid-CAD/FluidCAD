// Rejection table for legacy pen/imperative sketch commands inside a
// solved-mode (constraint) sketch. Keyed by getUniqueType() so the check in
// GeometrySceneObject.validate() needs no imports of the legacy classes.
// Derived edge ops (offset, trim, fillet2d, mirror2d, text, project, ...)
// consume built edges rather than pen state and are deliberately absent —
// P6 audits them against solved sketches.

const PEN_MESSAGE = 'pen commands do not exist in a constraint sketch — geometry statements are fully specified (line(start, end), arc(start, end, center), circle(center, d))';

const REJECTIONS: Record<string, string> = {
  'move': `move() ${PEN_MESSAGE}`,
  'hmove': `hMove() ${PEN_MESSAGE}`,
  'vmove': `vMove() ${PEN_MESSAGE}`,
  'pmove': `pMove() ${PEN_MESSAGE}`,
  'rmove': `rMove() ${PEN_MESSAGE}`,
  'back': `back() ${PEN_MESSAGE}`,
  'plane-center': `center() ${PEN_MESSAGE}`,
  'line-two-points': `line(end) can't be used in a constraint sketch — write line(start, end) and pin the junction with coincident(...)`,
  'hline': `hLine can't be used in a constraint sketch — use line(start, end) + horizontal(l)`,
  'vline': `vLine can't be used in a constraint sketch — use line(start, end) + vertical(l)`,
  'tline': `tLine can't be used in a constraint sketch — use line(start, end) + tangent(other, l)`,
  'one-object-tline': `tLine can't be used in a constraint sketch — use line(start, end) + tangent(other, l)`,
  'two-objects-tline': `tLine can't be used in a constraint sketch — use line(start, end) + tangent(...)`,
  'aline': `aLine can't be used in a constraint sketch — use line(start, end) + angle(a, b, deg)`,
  'arc': `arc in a constraint sketch needs full specification — arc(start, end, center)`,
  'arc-from-center': `arc in a constraint sketch needs full specification — arc(start, end, center)`,
  'circle': `circle in a constraint sketch needs an explicit center — circle(center, diameter)`,
  'tarc-to-point': `tArc can't be used in a constraint sketch — use arc(start, end, center) + tangent(prev, a)`,
  'tarc-to-point-tangent': `tArc can't be used in a constraint sketch — use arc(start, end, center) + tangent(prev, a)`,
  'tarc-with-tangent': `tArc can't be used in a constraint sketch — use arc(start, end, center) + tangent(prev, a)`,
  'tarc-radius-to-point': `tArc can't be used in a constraint sketch — use arc(start, end, center) + tangent(prev, a)`,
  'tarc-radius-to-object': `tArc can't be used in a constraint sketch — use arc(start, end, center) + tangent(...)`,
  'tarc-to-object': `tArc can't be used in a constraint sketch — use arc(start, end, center) + tangent(...)`,
  'two-objects-tarc': `tArc can't be used in a constraint sketch — use arc(start, end, center) + tangent(...)`,
  'two-objects-tcircle': `tCircle can't be used in a constraint sketch — use circle(center, d) + tangent(...)`,
  'connect': `connect() can't be used in a constraint sketch — close the profile with an explicit line + coincident(...)`,
  'rect': `rect() isn't available in a constraint sketch yet — draw 4 lines + coincident/horizontal/vertical constraints`,
  'slot': `slot() isn't available in a constraint sketch yet — draw 2 lines + 2 arcs + coincident/tangent/equal constraints`,
  'slot-from-edge': `slot() isn't available in a constraint sketch yet — draw 2 lines + 2 arcs + coincident/tangent/equal constraints`,
  'polygon': `polygon() isn't available in a constraint sketch yet — draw n lines + coincident/equal/angle constraints`,
};

/** The build error a legacy command raises inside a solved-mode sketch, or
 * null when the command is allowed there. */
export function solvedModeRejection(uniqueType: string): string | null {
  return REJECTIONS[uniqueType] ?? null;
}

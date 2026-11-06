/**
 * The built-in appearances a part may wear — `part(...).appearance(id)`.
 *
 * An appearance is a LOOK, not a substance: `.material(id)` names what a
 * part is made of (its density, for mass), `.appearance(id)` how the
 * viewport shades it. The two are independent, so a 3D-printed part can
 * be measured as PLA and shown as oak. A face painted with `color()`
 * keeps its flat colour over the appearance: paint is the override.
 *
 * Every entry is a physically-based preset the viewer builds a PBR
 * material from, with nothing to download: a `wood` entry adds procedural
 * grain — stripes along the body's longest axis, rings on its ends —
 * computed in the shader from the part-space position, so it is
 * continuous across faces, seamless at every edge and sized in real
 * millimetres whatever the document unit.
 */
export type AppearanceWood = {
  /** How dark the grain stripes are against the base colour, 0 (none) … 1. */
  stripeVisibility: number;
};

export type Appearance = {
  /** The id `.appearance(id)` takes. */
  id: string;
  name: string;
  /** The base colour as `#rrggbb`. */
  color: string;
  /** 0 (mirror) … 1 (fully diffuse). */
  roughness: number;
  /** 0 (dielectric) … 1 (metal). */
  metalness: number;
  wood?: AppearanceWood;
};

function plain(id: string, name: string, color: string, roughness: number, metalness: number): Appearance {
  return { id, name, color, roughness, metalness };
}

function wood(id: string, name: string, color: string, stripeVisibility: number): Appearance {
  return { id, name, color, roughness: 0.62, metalness: 0, wood: { stripeVisibility } };
}

export const APPEARANCES: readonly Appearance[] = [
  wood('oak',       'Oak',             '#bd926a', 0.7),
  wood('walnut',    'Walnut',          '#a17a5c', 0.7),
  plain('steel',    'Steel',           '#b8bcc0', 0.38, 1),
  plain('aluminum', 'Aluminum',        '#d3d6d9', 0.5,  1),
  plain('brass',    'Brass',           '#d4aa50', 0.32, 1),
  plain('copper',   'Copper',          '#c2704a', 0.3,  1),
  plain('plastic',  'Plastic (matte)', '#d9dadb', 0.72, 0),
  plain('rubber',   'Rubber',          '#2e2f31', 0.95, 0),
];

/** The appearance `id` names, or undefined for an id the table lacks — a warning on the part's row, never a build failure. */
export function resolveAppearance(id: string): Appearance | undefined {
  return APPEARANCES.find(appearance => appearance.id === id);
}

export function isAppearanceId(value: unknown): value is string {
  return typeof value === 'string' && resolveAppearance(value) !== undefined;
}

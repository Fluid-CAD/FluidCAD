import cubeSource from '!!raw-loader!../models/hero-cube.part.js';
import cylinderSource from '!!raw-loader!../models/hero-cylinder.part.js';
import hingeSource from '!!raw-loader!../models/hero-hinge.assembly.js';

export type HeroModel = {
  id: string;
  /** Button label. Two words at most — these sit in a tight row. */
  label: string;
  /** One line under the label. What this model demonstrates, not what it is. */
  blurb: string;
  /** Filename the viewer builds. The suffix selects part vs assembly. */
  entry: string;
  source: string;
  /** Square, transparent render of the part for the switcher. */
  thumbnail: string;
};

export const HERO_MODELS: HeroModel[] = [
  {
    id: 'cube',
    label: 'Cube',
    blurb: 'One square sketch, one extrude.',
    entry: 'cube.part.js',
    source: cubeSource,
    thumbnail: '/img/landing/thumb-cube.png',
  },
  {
    id: 'cylinder',
    label: 'Bored cylinder',
    blurb: 'A circle, an extrude, then a cut through it.',
    entry: 'cylinder.part.js',
    source: cylinderSource,
    thumbnail: '/img/landing/thumb-cylinder.png',
  },
  {
    id: 'hinge',
    label: 'Hinged blocks',
    blurb: 'Two parts, one revolute joint between them.',
    entry: 'hinge.assembly.js',
    source: hingeSource,
    thumbnail: '/img/landing/thumb-hinge.png',
  },
];

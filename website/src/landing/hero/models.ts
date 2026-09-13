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
  poster: string;
  /**
   * Alt text for the poster. Read out when the still is all a visitor gets
   * (no WebGL, no cross-origin isolation), so it describes the part.
   */
  posterAlt: string;
  /** Walk the feature tree automatically. Assemblies are shown built. */
  replay: boolean;
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
    poster: '/img/landing/hero-cube.png',
    posterAlt: 'A 60 mm cube standing on the ground plane.',
    replay: true,
  },
  {
    id: 'cylinder',
    label: 'Bored cylinder',
    blurb: 'A circle, an extrude, then a cut through it.',
    entry: 'cylinder.part.js',
    source: cylinderSource,
    thumbnail: '/img/landing/thumb-cylinder.png',
    poster: '/img/landing/hero-cylinder.png',
    posterAlt: 'A short cylinder with a round bore through its centre.',
    replay: true,
  },
  {
    id: 'hinge',
    label: 'Hinged blocks',
    blurb: 'Two parts, one revolute joint between them.',
    entry: 'hinge.assembly.js',
    source: hingeSource,
    thumbnail: '/img/landing/thumb-hinge.png',
    poster: '/img/landing/hero-hinge.png',
    posterAlt: 'A square block with a thinner one closed onto it, the two hinged along their front edge.',
    replay: false,
  },
];

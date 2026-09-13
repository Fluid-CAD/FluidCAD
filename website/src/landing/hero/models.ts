import hubSource from '!!raw-loader!../models/hero-hub.part.js';
import spacerSource from '!!raw-loader!../models/hero-spacer.part.js';
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
    id: 'hub',
    label: 'Flanged hub',
    blurb: 'Extrude, bore, then pattern one hole four ways.',
    entry: 'hub.part.js',
    source: hubSource,
    thumbnail: '/img/landing/thumb-hub.png',
    poster: '/img/landing/hero-hub.png',
    posterAlt:
      'A rectangular mounting plate with rounded corners, a bored cylindrical hub filleted into its top face, and four bolt holes.',
    replay: true,
  },
  {
    id: 'spacer',
    label: 'Fluted spacer',
    blurb: 'One cut, repeated eight times around the axis.',
    entry: 'spacer.part.js',
    source: spacerSource,
    thumbnail: '/img/landing/thumb-spacer.png',
    poster: '/img/landing/hero-spacer.png',
    posterAlt:
      'A thick cylindrical spacer with a central bore and eight scalloped flutes cut evenly around its rim.',
    replay: true,
  },
  {
    id: 'hinge',
    label: 'Hinged case',
    blurb: 'Two parts, one revolute joint, solved live.',
    entry: 'case.assembly.js',
    source: hingeSource,
    thumbnail: '/img/landing/thumb-hinge.png',
    poster: '/img/landing/hero-hinge.png',
    posterAlt:
      'A shelled rectangular case and its lid, hinged open flat beside each other.',
    replay: false,
  },
];

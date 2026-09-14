import cylinderSource from '!!raw-loader!../models/hero-cylinder.part.js';
import hingeSource from '!!raw-loader!../models/hero-hinge.assembly.js';

// The four-cylinder engine is a real workspace, not a snippet: a crank, a
// piston assembly built from five parts, and one replicate that puts four of
// them on the crank's throws. Every file it imports has to travel with it,
// under the name its importer uses.
import engineInit from '!!raw-loader!../models/engine/init.js';
import engineMain from '!!raw-loader!../models/engine/main.assembly.js';
import engineCrank from '!!raw-loader!../models/engine/crank-shaft.fluid.js';
import enginePistonAssembly from '!!raw-loader!../models/engine/piston.assembly.js';
import enginePiston from '!!raw-loader!../models/engine/piston.part.js';
import engineRod from '!!raw-loader!../models/engine/connecting-rod.part.js';
import enginePin from '!!raw-loader!../models/engine/pin.part.js';
import engineRing from '!!raw-loader!../models/engine/piston-ring.part.js';

export type HeroModel = {
  id: string;
  /** Button label. Two words at most — these sit in a tight row. */
  label: string;
  /** One line under the label. What this model demonstrates, not what it is. */
  blurb: string;
  /** Which file the viewer builds. The suffix selects part vs assembly. */
  entry: string;
  /**
   * The workspace, keyed by the path each file is imported under. One entry
   * for a model that is a single file; every file it reaches for otherwise.
   */
  files: Record<string, string>;
  /** Square, transparent render of the part for the switcher. */
  thumbnail: string;
};

export const HERO_MODELS: HeroModel[] = [
  {
    id: 'engine',
    label: 'Four-cylinder',
    blurb: 'Pistons on a crank, mated and replicated.',
    entry: 'main.assembly.js',
    files: {
      'init.js': engineInit,
      'main.assembly.js': engineMain,
      'crank-shaft.fluid.js': engineCrank,
      'piston.assembly.js': enginePistonAssembly,
      'piston.part.js': enginePiston,
      'connecting-rod.part.js': engineRod,
      'pin.part.js': enginePin,
      'piston-ring.part.js': engineRing,
    },
    thumbnail: '/img/landing/thumb-engine.png',
  },
  {
    id: 'cylinder',
    label: 'Bored cylinder',
    blurb: 'A circle, an extrude, then a cut through it.',
    entry: 'cylinder.part.js',
    files: {'cylinder.part.js': cylinderSource},
    thumbnail: '/img/landing/thumb-cylinder.png',
  },
  {
    id: 'hinge',
    label: 'Hinged blocks',
    blurb: 'Two parts, one revolute joint between them.',
    entry: 'hinge.assembly.js',
    files: {'hinge.assembly.js': hingeSource},
    thumbnail: '/img/landing/thumb-hinge.png',
  },
];

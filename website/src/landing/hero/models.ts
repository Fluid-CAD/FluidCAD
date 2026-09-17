import type {ViewerAnimation, ViewerView} from '@site/src/lib/viewer-embed';
import cylinderSource from '!!raw-loader!../models/hero-cylinder.part.js';
import hingeSource from '!!raw-loader!../models/hero-hinge.assembly.js';

// The four-cylinder engine is a real workspace, not a snippet: a crank, a
// piston assembly built from five parts, and one replicate that puts four of
// them on the crank's throws. Every file it imports has to travel with it,
// under the name its importer uses.
import engineInit from '!!raw-loader!../models/engine/init.js';
import engineMain from '!!raw-loader!../models/engine/main.assembly.js';
import engineCrank from '!!raw-loader!../models/engine/crank-shaft.part.js';
import enginePistonAssembly from '!!raw-loader!../models/engine/piston.assembly.js';
import enginePiston from '!!raw-loader!../models/engine/piston.part.js';
import engineRod from '!!raw-loader!../models/engine/connecting-rod.part.js';
import enginePin from '!!raw-loader!../models/engine/piston-pin.part.js';
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
  /**
   * The direction the hero looks at this model from, as an `x,y,z` ratio.
   * Defaults to {@link HERO_DEFAULT_VIEW}, which is the angle the app itself
   * opens on. A model whose shape wants a different one says so: the viewer
   * frames whatever it can see, so the angle decides how much of the sheet
   * there is to fill.
   */
  view?: ViewerView;
  animation?: ViewerAnimation;
};

/**
 * The angle the app opens every scene on, written as a direction. Good for a
 * compact model, which is most of them.
 */
export const HERO_DEFAULT_VIEW: ViewerView = '5,-5,4';

export const HERO_MODELS: HeroModel[] = [
  {
    id: 'engine',
    label: 'Four-cylinder',
    blurb: 'Pistons on a crank, mated and replicated.',
    entry: 'main.assembly.js',
    animation: {mate: 'crank-drive', owner: '', autoplay: true},
    files: {
      'init.js': engineInit,
      'main.assembly.js': engineMain,
      'crank-shaft.part.js': engineCrank,
      'piston.assembly.js': enginePistonAssembly,
      'piston.part.js': enginePiston,
      'connecting-rod.part.js': engineRod,
      'piston-pin.part.js': enginePin,
      'piston-ring.part.js': engineRing,
    },
    thumbnail: '/img/landing/thumb-engine.png',
    // Round to the right of the default, but not all the way to a side
    // elevation: the crank still runs at an angle into the frame, nose
    // towards the viewer and flange away, while lying across the sheet
    // rather than climbing a frame twice as wide as it is tall. Lower the
    // first number to swing further round and tip the crank up more.
    view: '1.7,-1,1',
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

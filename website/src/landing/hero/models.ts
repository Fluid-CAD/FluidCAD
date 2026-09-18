import type {ViewerAnimation, ViewerView} from '@site/src/lib/viewer-embed';
import quickReturnMain from '!!raw-loader!../models/quick-return/main.assembly.js';
import quickReturnFrame from '!!raw-loader!../models/quick-return/frame.part.js';
import quickReturnWheel from '!!raw-loader!../models/quick-return/wheel.part.js';
import quickReturnArm from '!!raw-loader!../models/quick-return/arm.part.js';
import quickReturnLink from '!!raw-loader!../models/quick-return/link.part.js';
import quickReturnPin from '!!raw-loader!../models/quick-return/pin.part.js';
import quickReturnRam from '!!raw-loader!../models/quick-return/ram.part.js';
import quickReturnGuide from '!!raw-loader!../models/quick-return/guide.part.js';
import quickReturnBolt from '!!raw-loader!../models/quick-return/bolt.part.js';
import quickReturnProfiles from '!!raw-loader!../models/quick-return/profiles.js';
import quickReturnDimensions from '!!raw-loader!../models/quick-return/dimensions.js';
import hingeSource from '!!raw-loader!../models/hero-hinge.assembly.js';
import hingeFixedLeaf from '!!raw-loader!../models/box-fixed-leaf.part.js';
import hingeMovingLeaf from '!!raw-loader!../models/box-moving-leaf.part.js';
import hingePin from '!!raw-loader!../models/box-pin.part.js';

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
    id: 'quick-return',
    label: 'Quick return',
    blurb: 'Revolute, slider, and tangent mates in motion.',
    entry: 'main.assembly.js',
    animation: {mate: 'crank-drive', autoplay: true},
    files: {
      'init.js': engineInit,
      'main.assembly.js': quickReturnMain,
      'frame.part.js': quickReturnFrame,
      'wheel.part.js': quickReturnWheel,
      'arm.part.js': quickReturnArm,
      'link.part.js': quickReturnLink,
      'pin.part.js': quickReturnPin,
      'ram.part.js': quickReturnRam,
      'guide.part.js': quickReturnGuide,
      'bolt.part.js': quickReturnBolt,
      'profiles.js': quickReturnProfiles,
      'dimensions.js': quickReturnDimensions,
    },
    thumbnail: '/img/landing/thumb-quick-return.png',
    view: '1,-2,0.75',
  },
  {
    id: 'hinge',
    label: 'Box hinge',
    blurb: 'Two leaves and a pin, joined with mates.',
    entry: 'hinge.assembly.js',
    animation: {mate: 'hinge-swing', autoplay: true, playback: 'reciprocate'},
    files: {
      'init.js': engineInit,
      'hinge.assembly.js': hingeSource,
      'box-fixed-leaf.part.js': hingeFixedLeaf,
      'box-moving-leaf.part.js': hingeMovingLeaf,
      'box-pin.part.js': hingePin,
    },
    thumbnail: '/img/landing/thumb-hinge.png',
  },
];

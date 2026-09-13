import {useCallback, useEffect, useRef, useState} from 'react';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {IconBrandGithub} from '@tabler/icons-react';
import {HERO_MODELS, type HeroModel} from './models';
import HeroViewport from './HeroViewport';
import styles from './Hero.module.css';

/**
 * Width the overlaid layout needs before the copy can sit on the viewport.
 *
 * Measured, not chosen. Below this the copy column is narrow enough that the
 * switcher's three buttons no longer fit across the room left of it and wrap
 * to a second row; that taller frame is what the viewer fits the model into,
 * so the model grows and lands on the copy it is supposed to sit clear of.
 * Under the threshold the stacked layout gives the scene the whole width and
 * the copy its own line, which is the better composition anyway.
 */
const OVERLAY_MIN_WIDTH = 1240;
/** The feature rail's own footprint inside the frame: 1.5rem inset + 220px. */
const RAIL_CLEARANCE_PX = 268;
/** The rail's own chrome above its first row's caps: 12px of panel padding,
 *  4px around the list, 6px around the row, and 5.6px of half-leading above
 *  a 14px/20px row. Fixed, because the rail's type doesn't scale with the
 *  page. Measured with the timeline at rest — it scrolls its own rows once
 *  the replay is under way. */
const RAIL_ROW_CAP_PX = 28;

let metricsCanvas: CanvasRenderingContext2D | null = null;

/**
 * How far a line's caps sit below the top of its line box.
 *
 * The rail docks to the headline's first line, not to its box, and the two
 * are not the same distance apart at every size: that line is set in an
 * italic serif whose ascenders overshoot its caps, and it resizes with its
 * column. Reading the face's own metrics keeps the dock true at any size, and
 * through a change of typeface — so this must be given the line itself, not
 * the heading that holds it.
 */
function capInset(line: HTMLElement): number {
  metricsCanvas ??= document.createElement('canvas').getContext('2d');
  if (!metricsCanvas) {
    return 0;
  }
  const style = getComputedStyle(line);
  const size = parseFloat(style.fontSize);
  const leading = parseFloat(style.lineHeight);
  metricsCanvas.font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`;
  const m = metricsCanvas.measureText('M');
  const halfLeading =
    (leading - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2;
  return halfLeading + m.fontBoundingBoxAscent - m.actualBoundingBoxAscent;
}

export default function Hero() {
  const [activeId, setActiveId] = useState(HERO_MODELS[0].id);
  const active = HERO_MODELS.find((m) => m.id === activeId) ?? HERO_MODELS[0];

  const frameRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  // Matched synchronously on the client so the frame mounts with its final
  // chrome — a later flip re-keys the iframe and throws away a warm engine.
  const [overlaid, setOverlaid] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(`(min-width: ${OVERLAY_MIN_WIDTH}px)`).matches,
  );
  const [shift, setShift] = useState({x: 0, y: 0});
  const [inset, setInset] = useState({top: 0, bottom: 0});

  // Everything the frame shares with the page is measured, not guessed: the
  // model is centred in the room left between the rail, the copy and the
  // switcher, and the rail is docked to the same band the copy occupies.
  const measure = useCallback((isOverlaid: boolean) => {
    const frame = frameRef.current;
    const copy = copyRef.current;
    const switcher = switcherRef.current;
    if (!frame || !copy || !switcher) {
      return;
    }
    if (!isOverlaid) {
      setShift({x: 0, y: 0});
      setInset({top: 0, bottom: 0});
      return;
    }
    const frameBox = frame.getBoundingClientRect();
    const copyBox = copy.getBoundingClientRect();
    const switcherBox = switcher.getBoundingClientRect();
    const clearCentre = (RAIL_CLEARANCE_PX + (copyBox.left - frameBox.left)) / 2;
    const bottomBand = Math.max(0, frameBox.bottom - switcherBox.top);
    // The switcher's own gap counts as claimed too. Only the lift uses it:
    // the model is centred in what is left once the gap is spent, so it keeps
    // that much air above the buttons instead of settling onto them. Growing
    // the frame instead would not do it — the viewer fits the model to the
    // frame, so a taller frame is only a bigger model in the same place.
    const gap = parseFloat(getComputedStyle(frame).rowGap) || 0;
    setShift({
      x: Math.max(0, Math.round(frameBox.width / 2 - clearCentre)),
      // Half of what the page has taken at the foot of the frame: lifting by
      // that much re-centres the model in what is left of it.
      y: Math.round((bottomBand + gap) / 2),
    });
    // The rail starts on the headline's line and stops above the switcher, so
    // the two columns of chrome read as one band across the hero.
    //
    // The headline's own rect is no good here: it rises into place on load,
    // and a rect taken mid-animation reads up to 14px low, which put the rail
    // wherever the measurement happened to land. The column doesn't move, and
    // the headline sits flush at its top, so the column gives the resting top
    // of the line box; the face's metrics give the caps inside it.
    const firstLine = copy.querySelector('h1')?.firstElementChild as HTMLElement | null;
    const titleTop = copyBox.top - frameBox.top;
    const titleCap = firstLine ? capInset(firstLine) : 0;
    setInset({
      top: Math.max(0, Math.round(titleTop + titleCap - RAIL_ROW_CAP_PX)),
      bottom: Math.round(bottomBand),
    });
  }, []);

  useEffect(() => {
    const wide = window.matchMedia(`(min-width: ${OVERLAY_MIN_WIDTH}px)`);
    const sync = () => {
      setOverlaid(wide.matches);
      measure(wide.matches);
    };
    sync();
    wide.addEventListener('change', sync);
    const observer = new ResizeObserver(() => measure(wide.matches));
    for (const el of [frameRef.current, switcherRef.current]) {
      if (el) {
        observer.observe(el);
      }
    }
    // The dock is read off the headline's own face, so it is only right once
    // that face has arrived — until then the fallback's metrics are showing,
    // and the serif's are far enough from Georgia's to see. `loadingdone`
    // rather than `fonts.ready`: the headline's face is requested by its own
    // first paint, which can land after ready has already resolved.
    const remeasure = () => measure(wide.matches);
    document.fonts?.addEventListener('loadingdone', remeasure);
    return () => {
      document.fonts?.removeEventListener('loadingdone', remeasure);
      wide.removeEventListener('change', sync);
      observer.disconnect();
    };
  }, [measure]);

  return (
    <section className={styles.hero}>
      <div ref={frameRef} className={styles.frame}>
        <BrowserOnly fallback={<PosterFallback model={active} />}>
          {() => (
            <HeroViewport
              className={styles.viewportLayer}
              model={active}
              withTimeline={overlaid}
              viewShiftX={shift.x}
              viewShiftY={shift.y}
              panelInset={inset}
            />
          )}
        </BrowserOnly>

        <div ref={copyRef} className={styles.copy}>
          {/* Each line is set in the thing it names: the mouse half in the
              italic serif, the code half in the same mono the editor uses. */}
          <Heading as="h1" className={styles.title}>
            {/* The space between is dropped in block layout, and keeps the
                two sentences apart for anything reading the text. */}
            <span className={styles.titleMouse}>Model with the mouse.</span>{' '}
            <span className={styles.titleCode}>
              {/* The caret is drawn on the outer span so the clip that types
                  this line doesn't cut it off along with the text. */}
              <span className={styles.titleCodeText}>Control it with code.</span>
            </span>
          </Heading>
          <p className={styles.sub}>
            FluidCAD is hybrid CAD. Sketch, extrude, fillet and the rest by clicking, then drop
            into JavaScript for what a dialog cannot say. One file, on the OpenCascade{' '}
            <span className={styles.unbroken}>B-Rep</span> kernel.
          </p>
          <div className={styles.actions}>
            <Link className={styles.primary} to="/docs/getting-started">
              Get started
            </Link>
            <Link className={styles.secondary} href="https://github.com/Fluid-CAD/FluidCAD">
              <IconBrandGithub size={18} stroke={1.75} aria-hidden />
              View the source
            </Link>
          </div>
        </div>

        <div ref={switcherRef} className={styles.switcher} role="group" aria-label="Choose a model">
          {HERO_MODELS.map((model) => (
            <button
              key={model.id}
              type="button"
              className={styles.chip}
              aria-pressed={model.id === activeId}
              onClick={() => setActiveId(model.id)}>
              <img className={styles.chipThumb} src={model.thumbnail} alt="" width={256} height={256} />
              <span className={styles.chipText}>
                <span className={styles.chipLabel}>{model.label}</span>
                <span className={styles.chipBlurb}>{model.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/** What the server renders, and what a browser without JS keeps. */
function PosterFallback({model}: {model: HeroModel}) {
  return (
    <div className={`${styles.viewportLayer} ${styles.fallback}`}>
      <img src={model.poster} alt={model.posterAlt} width={1500} height={1000} />
    </div>
  );
}

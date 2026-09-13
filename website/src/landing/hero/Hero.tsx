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

export default function Hero() {
  const [activeId, setActiveId] = useState(HERO_MODELS[0].id);
  const active = HERO_MODELS.find((m) => m.id === activeId) ?? HERO_MODELS[0];

  const frameRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState({x: 0, y: 0});
  const [band, setBand] = useState(0);

  // Everything the frame shares with the page is measured, not guessed: the
  // model is centred in the room the copy and the switcher leave it.
  const measure = useCallback((isOverlaid: boolean) => {
    const frame = frameRef.current;
    const copy = copyRef.current;
    const switcher = switcherRef.current;
    if (!frame || !copy || !switcher) {
      return;
    }
    if (!isOverlaid) {
      setShift({x: 0, y: 0});
      setBand(0);
      return;
    }
    const frameBox = frame.getBoundingClientRect();
    const copyBox = copy.getBoundingClientRect();
    const switcherBox = switcher.getBoundingClientRect();
    // The scene has the frame to itself as far as the copy's left edge.
    const clearCentre = (copyBox.left - frameBox.left) / 2;
    const bottomBand = Math.max(0, frameBox.bottom - switcherBox.top);
    setShift({
      x: Math.max(0, Math.round(frameBox.width / 2 - clearCentre)),
      // Half of what the page has taken at the foot of the frame: lifting by
      // exactly that re-centres the model in what is left of it. No more than
      // that — the viewer fits the model to the whole frame, so a model that
      // fills the frame has only its fit margin to spare, and a lift past it
      // is the model's own top going off the edge.
      y: Math.round(bottomBand / 2),
    });
    setBand(Math.round(bottomBand));
  }, []);

  useEffect(() => {
    const wide = window.matchMedia(`(min-width: ${OVERLAY_MIN_WIDTH}px)`);
    const sync = () => measure(wide.matches);
    sync();
    wide.addEventListener('change', sync);
    const observer = new ResizeObserver(() => measure(wide.matches));
    for (const el of [frameRef.current, switcherRef.current]) {
      if (el) {
        observer.observe(el);
      }
    }
    // The copy column is set in faces that arrive after first paint, and its
    // width settles with them — so the model's clearance is only right once
    // they have landed. `loadingdone` rather than `fonts.ready`: a face is
    // requested by its own first paint, which can follow ready resolving.
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
              viewShiftX={shift.x}
              viewShiftY={shift.y}
              band={band}
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

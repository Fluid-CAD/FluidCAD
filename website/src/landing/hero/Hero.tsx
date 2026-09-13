import {useState} from 'react';
import Link from '@docusaurus/Link';
import Heading from '@theme/Heading';
import BrowserOnly from '@docusaurus/BrowserOnly';
import {IconBrandGithub} from '@tabler/icons-react';
import {HERO_MODELS} from './models';
import HeroViewport from './HeroViewport';
import styles from './Hero.module.css';

/**
 * A drafting table with one sheet laid on it.
 *
 * The gridded band behind the headline is the table. It stops a little way
 * down the viewer, so the instrument is caught by its top edge and the rest
 * lies out on the open page — the overlap is a grid row boundary, not a
 * measured offset, so nothing here needs JavaScript to stay in register.
 */
export default function Hero() {
  const [activeId, setActiveId] = useState(HERO_MODELS[0].id);
  const active = HERO_MODELS.find((m) => m.id === activeId) ?? HERO_MODELS[0];

  return (
    <section className={styles.hero}>
      <div className={styles.table} aria-hidden="true" />

      <div className={styles.header}>
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

      {/* Empty until the client mounts, and empty is right: the frame paints
          its own "Loading engine…" the moment it is there, and a still of the
          finished part standing in for it only ever made the real thing look
          like a redraw. */}
      <div className={styles.sheet}>
        <BrowserOnly>
          {() => <HeroViewport className={styles.viewport} model={active} />}
        </BrowserOnly>
      </div>

      <div className={styles.switcher} role="group" aria-label="Choose a model">
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
    </section>
  );
}

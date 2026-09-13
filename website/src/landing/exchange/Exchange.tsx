import {useCallback, useEffect, useRef, useState} from 'react';
import {Section, SectionHead} from '../Section';
import CodePane from '../CodePane';
import {BEATS, fileAt} from './steps';
import styles from './Exchange.module.css';

/** Long enough to read the gesture and find the line it wrote. */
const BEAT_MS = 3600;

export default function Exchange() {
  const [index, setIndex] = useState(0);
  /** Set the moment a visitor picks a beat: the replay is theirs from then on. */
  const [held, setHeld] = useState(false);
  const [running, setRunning] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  // The replay only runs while the section is on screen. A page that keeps a
  // timer going three folds above the fold is spending someone's battery to
  // animate nothing.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => setRunning(entries.some((entry) => entry.isIntersecting)),
      {threshold: 0.3},
    );
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!running || held) {
      return undefined;
    }
    const timer = setTimeout(() => setIndex((i) => (i + 1) % BEATS.length), BEAT_MS);
    return () => clearTimeout(timer);
  }, [running, held, index]);

  const pick = useCallback((next: number) => {
    setHeld(true);
    setIndex(next);
  }, []);

  const beat = BEATS[index];
  const {code, from, to} = fileAt(index);

  return (
    <Section ground="sunken">
      <SectionHead
        title="What you do with the mouse lands in the file"
        lead="Sketch, extrude, cut, fillet: every tool writes one plain JavaScript statement into a file you keep. Nothing goes into a format only this program can open. The last step below runs the other way, from a number you type back to the solid."
      />

      <div ref={stageRef} className={styles.stage}>
        {/* Set like the app's History panel, because that is what it is: the
            steps of one build, in order, each one selectable. The last row is
            ruled off — it is not a feature, it is the file being edited. */}
        <ol className={styles.tree} aria-label="Build steps">
          {BEATS.map((step, i) => (
            <li key={step.id} className={step.rewrites ? styles.apart : undefined}>
              <button
                type="button"
                className={styles.feature}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => pick(i)}>
                <span className={styles.featureIndex} aria-hidden="true">
                  {i + 1}
                </span>
                <span className={styles.featureName}>{step.tool}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className={styles.viewport}>
          <div className={styles.frames}>
            {BEATS.map((step, i) => (
              <img
                key={step.id}
                src={step.image}
                alt={i === index ? step.alt : ''}
                className={styles.frame}
                data-shown={i === index || undefined}
                width={891}
                height={560}
                loading="lazy"
                decoding="async"
              />
            ))}
          </div>
          <p className={styles.gesture} key={beat.id}>
            <span className={styles.from}>
              {beat.rewrites ? 'From the editor' : 'From the viewport'}
            </span>
            {beat.gesture}
          </p>
        </div>

        <div className={styles.file}>
          <p className={styles.filename}>
            <span className={styles.dot} data-live={running && !held ? '' : undefined} aria-hidden="true" />
            rocker.fluid.js
          </p>
          <CodePane
            className={styles.pane}
            code={code}
            live={[from, to]}
            follow
            aria-label={`rocker.fluid.js after step ${index + 1} of ${BEATS.length}`}
          />
        </div>
      </div>

      <p className={styles.footnote}>
        The feature tree is that file read the other way. Click a feature to roll the model back to
        it, or put the cursor on its line; <code>breakpoint()</code> pins it there while you work on
        what came before.
      </p>
    </Section>
  );
}

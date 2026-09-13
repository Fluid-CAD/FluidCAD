import {Section} from '../Section';
import CodePane from '../CodePane';
import {useReveal} from '../useReveal';
import styles from './Assembly.module.css';

const SOURCE = `const frame = insert(bracket()).grounded();
const arm = insert(rocker());

mate("revolute", frame.connectors.pivot,
                 arm.connectors.pivot);`;

export default function Assembly() {
  const [ref, shown] = useReveal<HTMLDivElement>();

  return (
    <Section className={styles.section}>
      <div ref={ref} className={styles.split} data-shown={shown || undefined}>
        <div className={styles.copy}>
          <h2 className={styles.title}>Parts that know how they fit</h2>
          <p className={styles.lead}>
            A part is a function that returns geometry. Insert it as many times as you need, name a
            connector on the face or edge that does the locating, and mate the connectors. The
            solver holds every mate while you move whatever is still free.
          </p>

          <CodePane className={styles.pane} code={SOURCE} aria-label="An assembly with one revolute mate" />

          <dl className={styles.facts}>
            <div>
              <dt>Degrees of freedom</dt>
              <dd>
                <span className={styles.count}>1</span> rotation about the pivot, reported live as
                you mate.
              </dd>
            </div>
            <div>
              <dt>Mates</dt>
              <dd>Fastened, revolute, slider, cylindrical, planar, tangent.</dd>
            </div>
          </dl>

          {/* Principle 5: what is ahead is labelled as ahead. */}
          <p className={styles.ahead}>Driven joint animation is in progress.</p>
        </div>

        <figure className={styles.stage}>
          <img
            className={styles.render}
            src="/img/landing/assembly-linkage.png"
            alt="A grounded bracket with a rocker arm seated on its post, free to turn about the pivot."
            width={1020}
            height={520}
            loading="lazy"
            decoding="async"
          />
          <figcaption className={styles.pivot}>
            <span className={styles.pivotDot} aria-hidden="true" />
            revolute · bracket.pivot ↔ rocker.pivot
          </figcaption>
        </figure>
      </div>
    </Section>
  );
}

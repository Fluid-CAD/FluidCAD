import Link from '@docusaurus/Link'
import { Section } from '../Section'
import CodePane from '../CodePane'
import HeroViewport from '../hero/HeroViewport'
import { HERO_MODELS } from '../hero/models'
import styles from './Assembly.module.css'

const hinge = HERO_MODELS.find((model) => model.id === 'hinge')!
const SOURCE = `const block = insert(base()).grounded();
const lid = insert(flap());

mate("revolute",
  block.connectors.hinge,
  lid.connectors.hinge,
).rotate(65).limits(0, 180);`

export default function Assembly() {
  return (
    <Section>
      <div className={styles.split}>
        <div className={styles.copy}>
          <h2 className={styles.title}>Assemble parts. Define how they move.</h2>
          <p className={styles.lead}>
            Insert reusable parts, fix one in place, and join their connectors with mates. Keep a
            connection rigid, let a hinge rotate, or guide a part along a slide. The assembly solver
            keeps the connections together.
          </p>
          <CodePane
            className={styles.pane}
            code={SOURCE}
            aria-label="The hinge assembly shown in the viewer"
          />
          <p className={styles.lead}>
            <Link to="/docs/assembly">Explore assemblies →</Link>
          </p>
        </div>
        <figure className={styles.stage}>
          <HeroViewport model={hinge} className={styles.viewer} lazy />
          <figcaption className={styles.pivot}>
            <span className={styles.pivotDot} aria-hidden="true" />
            Two parts · one revolute mate · drag to orbit
          </figcaption>
        </figure>
      </div>
    </Section>
  )
}

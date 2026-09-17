import { useState } from 'react'
import { Section, SectionHead } from '../Section'
import CodePane from '../CodePane'
import HeroViewport from '../hero/HeroViewport'
import sketchIcon from '../../../../ui/public/icons/sketch.png'
import extrudeIcon from '../../../../ui/public/icons/extrude.png'
import cutIcon from '../../../../ui/public/icons/cut.png'
import filletIcon from '../../../../ui/public/icons/fillet.png'
import { STEPS, fileAt } from './steps'
import styles from './Exchange.module.css'

const ICONS = { sketch: sketchIcon, extrude: extrudeIcon, cut: cutIcon, fillet: filletIcon }
const models = STEPS.map((step, i) => ({
  id: 'rocker-' + step.id,
  label: step.label,
  blurb: step.detail,
  entry: 'rocker.part.js',
  files: { 'rocker.part.js': fileAt(i).code },
  thumbnail: '',
  // All three sketches lie on XY or a parallel top face.
  view: step.feature === 'sketch' ? ('top' as const) : ('5,-5,4' as const)
}))

export default function Exchange() {
  const [active, setActive] = useState(0)
  const step = STEPS[active]
  const { code, from, to } = fileAt(active)
  return (
    <Section ground="sunken">
      <SectionHead
        title="From a sketch to a solid"
        lead="Build a rocker arm, one feature at a time. Every sketch, extrusion, cut and fillet has its own place in the history, and its own lines in the file."
      />
      <div className={styles.workbench}>
        <div className={styles.toolbar}>
          <span className={styles.partName}>Rocker arm</span>
          <span className={styles.stepCount}>
            Feature {active + 1} of {STEPS.length}
          </span>
        </div>
        <div className={styles.workspace}>
          <ol className={styles.steps} aria-label="Modeling features">
            {STEPS.map(({ id, label, feature, summary }, i) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => setActive(i)}
                  aria-current={active === i ? 'step' : undefined}
                >
                  <img
                    className={styles.featureIcon}
                    src={ICONS[feature]}
                    width={24}
                    height={24}
                    alt=""
                  />
                  <span className={styles.featureText}>
                    <span className={styles.featureLabel}>{label}</span>
                    <span className={styles.featureSummary}>{summary}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className={styles.scene}>
            <HeroViewport model={models[active]} className={styles.viewer} lazy />
            <p className={styles.caption} aria-live="polite">
              {step.detail}
            </p>
          </div>
          <div className={styles.file}>
            <div className={styles.filename}>
              rocker.part.js <span>JavaScript</span>
            </div>
            <CodePane
              code={code}
              live={[from, to]}
              follow
              className={styles.code}
              aria-label={step.label + ' source code'}
            />
          </div>
        </div>
      </div>
      <p className={styles.footnote}>
        Choose a feature to see that point in the build. Its lines are highlighted in the file. Drag
        the model to explore it in 3D.
      </p>
    </Section>
  )
}

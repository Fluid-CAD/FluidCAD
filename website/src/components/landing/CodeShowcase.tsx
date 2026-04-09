import CodeBlock from '@theme/CodeBlock';
import styles from './CodeShowcase.module.css';

const CODE_EXAMPLE = `import { extrude, fillet, sketch } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xy", () => {
    circle(50)
})

const e = extrude(50)

fillet(5, e.startEdges())`;

export default function CodeShowcase() {
  return (
    <section className={styles.section}>
      <div className="container">
        <div className={styles.grid}>
          <div className={styles.textCol}>
            <h2 className={styles.heading}>
              Write code.<br />Get geometry.
            </h2>
            <p className={styles.description}>
              Design parametric 3D models using a clean JavaScript API.
              Every change in your code is reflected instantly in the 3D viewport.
              Sketches, extrusions, fillets, booleans. The full CAD workflow,
              driven entirely by code.
            </p>
            <p className={styles.subdesc}>
              Most operations just work without extra arguments.{' '}
              <code>extrude</code> picks up the last sketch,{' '}
              <code>fillet</code> targets the last selection, and touching
              shapes are automatically fused.
            </p>
          </div>
          <div className={styles.codeCol}>
            <div className={styles.codeWindow}>
              <div className={styles.windowChrome}>
                <span className={styles.dot} data-color="red" />
                <span className={styles.dot} data-color="yellow" />
                <span className={styles.dot} data-color="green" />
                <span className={styles.windowTitle}>my-part.fluid.js</span>
              </div>
              <div className={styles.codeBody}>
                <CodeBlock language="javascript">
                  {CODE_EXAMPLE}
                </CodeBlock>
              </div>
            </div>
            <div className={styles.placeholder}>
              <div className={styles.placeholderInner}>
                <div className={styles.placeholderIcon}>
                  <div className={styles.cubeIcon} />
                </div>
                <span className={styles.placeholderText}>
                  3D viewport preview coming soon
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

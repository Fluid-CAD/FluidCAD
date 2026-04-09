import Link from '@docusaurus/Link';
import CodeBlock from '@theme/CodeBlock';
import styles from './GetStartedSection.module.css';

const INSTALL_CMD = `npm create fluidcad-app@latest my-app
cd my-app
npm install`;

export default function GetStartedSection() {
  return (
    <section className={styles.section}>
      <div className={styles.gridBg} />
      <div className="container">
        <div className={styles.content}>
          <h2 className={styles.heading}>Start building in seconds</h2>
          <p className={styles.subtitle}>
            Scaffold a project, install dependencies, and start modeling.
          </p>
          <div className={styles.terminal}>
            <div className={styles.terminalChrome}>
              <span className={styles.dot} data-color="red" />
              <span className={styles.dot} data-color="yellow" />
              <span className={styles.dot} data-color="green" />
              <span className={styles.terminalTitle}>Terminal</span>
            </div>
            <div className={styles.terminalBody}>
              <CodeBlock language="bash">
                {INSTALL_CMD}
              </CodeBlock>
            </div>
          </div>
          <div className={styles.buttons}>
            <Link className={styles.btnPrimary} to="/docs/getting-started">
              Read the docs
            </Link>
            <Link
              className={styles.btnOutline}
              href="https://github.com/AouidaM/FluidCAD">
              View on GitHub
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

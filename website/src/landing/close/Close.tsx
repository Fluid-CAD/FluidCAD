import Link from '@docusaurus/Link';
import {IconBrandGithub} from '@tabler/icons-react';
import styles from './Close.module.css';

/**
 * The last word: who made it, under what licence, standing on what.
 *
 * No second call to action. The download section two folds up is the place
 * to act; repeating it here would only say the page did not trust it.
 */
export default function Close() {
  return (
    <section className={styles.close}>
      <div className={styles.column}>
        <p className={styles.line}>
          FluidCAD is open source under the MIT licence, built on{' '}
          <Link href="https://dev.opencascade.org/">OpenCascade</Link>, the B-Rep kernel that has
          been cutting exact geometry since before most of the CAD on your machine existed.
        </p>
        <div className={styles.links}>
          <Link className={styles.repo} href="https://github.com/Fluid-CAD/FluidCAD">
            <IconBrandGithub size={18} stroke={1.75} aria-hidden />
            Fluid-CAD/FluidCAD
          </Link>
          <Link className={styles.quiet} to="/docs/getting-started">
            Documentation
          </Link>
          <Link className={styles.quiet} to="/docs/api">
            API reference
          </Link>
          <Link className={styles.quiet} href="https://www.reddit.com/r/FluidCAD/">
            Ask a question
          </Link>
        </div>
      </div>
    </section>
  );
}

import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Heading from '@theme/Heading';
import styles from './HeroSection.module.css';

export default function HeroSection() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <section className={styles.hero}>
      <div className={styles.gridBg} />
      <div className="container">
        <div className={styles.content}>
          <Heading as="h1" className={styles.title}>
            {siteConfig.title}
          </Heading>
          <p className={styles.tagline}>{siteConfig.tagline}</p>
          <p className={styles.valueProp}>
            Write JavaScript. See 3D geometry in real time.
          </p>
          <div className={styles.buttons}>
            <Link
              className={styles.btnPrimary}
              to="/docs/getting-started">
              Get Started
            </Link>
            <Link
              className={styles.btnOutline}
              href="https://github.com/AouidaM/FluidCAD">
              View on GitHub
            </Link>
          </div>
        </div>
      </div>
      <div className={styles.fadeBottom} />
    </section>
  );
}

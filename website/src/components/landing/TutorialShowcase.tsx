import Link from '@docusaurus/Link';
import styles from './TutorialShowcase.module.css';

type Tutorial = {
  title: string;
  image: string;
  href: string;
};

const TUTORIALS: Tutorial[] = [
  {
    title: 'Lantern',
    image: '/img/docs/tutorials/lantern-final.png',
    href: '/docs/tutorials/lantern',
  },
  {
    title: 'Ice Cube Tray',
    image: '/img/docs/tutorials/ice-cube-tray-final.png',
    href: '/docs/tutorials/ice-cube-tray',
  },
  {
    title: 'Grooved Box',
    image: '/img/docs/tutorials/grooved-box-final.png',
    href: '/docs/tutorials/grooved-box',
  },
  {
    title: 'Flange With Notch',
    image: '/img/docs/tutorials/flange-with-notch-final.png',
    href: '/docs/tutorials/flange-with-notch',
  },
  {
    title: 'CSWP Sample Exam',
    image: '/img/docs/tutorials/cswp-sample-exam-final.png',
    href: '/docs/tutorials/cswp-sample-exam',
  },
];

export default function TutorialShowcase() {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.sectionTitle}>What you can build</h2>
        <p className={styles.sectionSubtitle}>
          Step-by-step tutorials from simple shapes to exam-level parts.
        </p>
        <div className={styles.grid}>
          {TUTORIALS.map((t) => (
            <Link key={t.title} to={t.href} className={styles.card}>
              <div className={styles.imageWrapper}>
                <img src={t.image} alt={t.title} className={styles.image} />
              </div>
              <span className={styles.title}>{t.title}</span>
            </Link>
          ))}
        </div>
        <div className={styles.cta}>
          <Link to="/docs/tutorials" className={styles.ctaLink}>
            View all tutorials &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

import type {ReactNode} from 'react';
import {
  IconHistory,
  IconHandClick,
  IconRotate,
  IconFileExport,
} from '@tabler/icons-react';
import styles from './ShowcaseSection.module.css';


type ShowcaseItem = {
  tag: string;
  title: string;
  description: string;
  media: string;
  mediaAlt: string;
  icon: ReactNode;
};

const SHOWCASES: ShowcaseItem[] = [
  {
    tag: 'History',
    title: 'Navigate Your Modeling History',
    description:
      'Step through your feature tree one operation at a time. Review how any model was built and roll back to any point — no destructive edits.',
    media: '/img/history.gif',
    mediaAlt: 'FluidCAD Modeling History',
    icon: <IconHistory size={14} stroke={2} />,
  },
  {
    tag: 'Interactive',
    title: 'Mouse-Driven Prototyping',
    description:
      'Extrude regions by dragging in the viewport. Get to the right shape faster, then lock in the values with code.',
    media: '/img/region-extrude.gif',
    mediaAlt: 'FluidCAD Interactive Prototyping',
    icon: <IconHandClick size={14} stroke={2} />,
  },
  {
    tag: 'Transforms',
    title: 'Feature Transforms & Patterns',
    description:
      'Apply linear and circular patterns to entire feature sequences. Mirror, rotate, and repeat complex geometry from simple building blocks.',
    media: '/img/repeat.png',
    mediaAlt: 'FluidCAD Feature Transforms',
    icon: <IconRotate size={14} stroke={2} />,
  },
  {
    tag: 'Interop',
    title: 'STEP Import & Export',
    description:
      'Import existing CAD models or export your designs with full color support. Works with every standard CAD tool.',
    media: '/img/step-import.png',
    mediaAlt: 'FluidCAD STEP Import / Export',
    icon: <IconFileExport size={14} stroke={2} />,
  },
];

export default function ShowcaseSection() {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.sectionTitle}>See it in action</h2>
        <p className={styles.sectionSubtitle}>
          From interactive viewport input to parametric history — a closer look at what makes FluidCAD different.
        </p>
        <div className={styles.showcases}>
          {SHOWCASES.map((item) => (
            <div key={item.title} className={styles.showcase}>
              <div className={styles.textCol}>
                <p className={styles.tag}>
                  {item.icon}
                  {item.tag}
                </p>
                <h3 className={styles.showcaseTitle}>{item.title}</h3>
                <p className={styles.showcaseDesc}>{item.description}</p>
              </div>
              <div className={styles.mediaCol}>
                <div className={styles.mediaCard}>
                  <img
                    src={item.media}
                    alt={item.mediaAlt}
                    className={styles.media}
                    loading="lazy"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

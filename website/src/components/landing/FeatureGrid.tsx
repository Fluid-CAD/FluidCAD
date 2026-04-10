import type {ReactNode} from 'react';
import {
  IconTopologyRing3,
  IconStack2,
  IconSparkles,
} from '@tabler/icons-react';
import styles from './FeatureGrid.module.css';

type Feature = {
  title: string;
  description: string;
  icon: ReactNode;
};

const FEATURES: Feature[] = [
  {
    title: 'Traditional CAD Workflow',
    description:
      'Sketches, extrusions, fillets, shells, booleans, and more. A modeling workflow familiar to CAD users.',
    icon: <IconStack2 size={28} stroke={1.5} />,
  },
  {
    title: 'Smart Defaults',
    description:
      'Most operations just do the right thing. extrude picks up the last sketch, fillet targets the last selection, touching shapes are automatically fused — less boilerplate, more readable code.',
    icon: <IconSparkles size={28} stroke={1.5} />,
  },
  {
    title: 'Shape References',
    description:
      'Reference faces, edges, and vertices of other shapes directly. Minimal math, maximum clarity.',
    icon: <IconTopologyRing3 size={28} stroke={1.5} />,
  },
];

export default function FeatureGrid() {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.sectionTitle}>CAD by Code as it should be</h2>
        <p className={styles.sectionSubtitle}>
          A complete toolbox for parametric CAD. From first sketch to final export.
        </p>
        <div className={styles.grid}>
          {FEATURES.map((f) => (
            <div key={f.title} className={styles.card}>
              <div className={styles.icon}>{f.icon}</div>
              <h3 className={styles.cardTitle}>{f.title}</h3>
              <p className={styles.cardDesc}>{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

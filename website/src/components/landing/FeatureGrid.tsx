import type {ReactNode} from 'react';
import {
  IconCode,
  IconTopologyRing3,
  IconStack2,
  IconHistory,
  IconHandClick,
  IconRotate,
  IconGridPattern,
  IconFileExport,
  IconTerminal2,
} from '@tabler/icons-react';
import styles from './FeatureGrid.module.css';

type Feature = {
  title: string;
  description: string;
  icon: ReactNode;
};

const FEATURES: Feature[] = [
  {
    title: 'Code-Driven 3D Modeling',
    description:
      'Design parametric 3D models using JavaScript. Every change in your code is reflected instantly in the viewport.',
    icon: <IconCode size={28} stroke={1.5} />,
  },
  {
    title: 'Shape References',
    description:
      'Reference faces, edges, and vertices of other shapes directly. Minimal math, maximum clarity.',
    icon: <IconTopologyRing3 size={28} stroke={1.5} />,
  },
  {
    title: 'Traditional CAD Workflow',
    description:
      'Sketches, extrusions, fillets, shells, booleans, and more. A modeling workflow familiar to CAD users.',
    icon: <IconStack2 size={28} stroke={1.5} />,
  },
  {
    title: 'Modeling History',
    description:
      'Navigate through your modeling history step by step. Review how any model was built and roll back to any point.',
    icon: <IconHistory size={28} stroke={1.5} />,
  },
  {
    title: 'Interactive Prototyping',
    description:
      'Some operations support interactive mouse-driven input directly in the viewport for faster prototyping.',
    icon: <IconHandClick size={28} stroke={1.5} />,
  },
  {
    title: 'Feature Transforms',
    description:
      'Move, rotate, or mirror entire feature sequences to build complex geometry from simple building blocks.',
    icon: <IconRotate size={28} stroke={1.5} />,
  },
  {
    title: 'Pattern Copying',
    description:
      'Duplicate features in linear or circular patterns to quickly populate repetitive geometry.',
    icon: <IconGridPattern size={28} stroke={1.5} />,
  },
  {
    title: 'STEP Import / Export',
    description:
      'Import and export STEP files with full color support. Share designs with any standard CAD tool.',
    icon: <IconFileExport size={28} stroke={1.5} />,
  },
  {
    title: 'Editor Support',
    description:
      'Official extensions for VS Code and Neovim, or use any editor. Just point the CLI at your project.',
    icon: <IconTerminal2 size={28} stroke={1.5} />,
  },
];

export default function FeatureGrid() {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.sectionTitle}>Everything you need</h2>
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

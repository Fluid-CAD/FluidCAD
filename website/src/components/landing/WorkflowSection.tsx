import type {ReactNode} from 'react';
import {
  IconCode,
  IconEye,
  IconRefresh,
  IconDownload,
} from '@tabler/icons-react';
import styles from './WorkflowSection.module.css';

type Step = {
  number: string;
  title: string;
  description: string;
  icon: ReactNode;
};

const STEPS: Step[] = [
  {
    number: '01',
    title: 'Write',
    description: 'Author your model in JavaScript using the FluidCAD API.',
    icon: <IconCode size={24} stroke={1.5} />,
  },
  {
    number: '02',
    title: 'Preview',
    description: 'See your 3D geometry update in real time as you code.',
    icon: <IconEye size={24} stroke={1.5} />,
  },
  {
    number: '03',
    title: 'Iterate',
    description: 'Navigate history, tweak parameters, and explore variants.',
    icon: <IconRefresh size={24} stroke={1.5} />,
  },
  {
    number: '04',
    title: 'Export',
    description: 'Export as STEP with full color support for any CAD tool.',
    icon: <IconDownload size={24} stroke={1.5} />,
  },
];

export default function WorkflowSection() {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.sectionTitle}>How it works</h2>
        <div className={styles.steps}>
          {STEPS.map((step, i) => (
            <div key={step.number} className={styles.step}>
              <div className={styles.stepTop}>
                <div className={styles.stepIcon}>{step.icon}</div>
                {i < STEPS.length - 1 && <div className={styles.connector} />}
              </div>
              <span className={styles.stepNumber}>{step.number}</span>
              <h3 className={styles.stepTitle}>{step.title}</h3>
              <p className={styles.stepDesc}>{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

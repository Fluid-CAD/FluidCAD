import type {ReactNode} from 'react';
import styles from './Section.module.css';

/**
 * The page's only shared furniture: a band, a column, and a heading pair.
 *
 * Deliberately thin. Each section below the hero has its own shape — a rail
 * of steps, a row of specimens, a list of hosts — and composing those out of
 * one card component is how a page ends up looking like every other page. The
 * shell only guarantees the two things that must not vary: how wide the
 * column is, and how a heading is set.
 */
export function Section({
  id,
  ground = 'plain',
  children,
  className,
}: {
  id?: string;
  /** `sunken` is the workbench ground — used twice on the page, not five times. */
  ground?: 'plain' | 'sunken';
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`${styles.section} ${styles[ground]} ${className ?? ''}`}>
      <div className={styles.column}>{children}</div>
    </section>
  );
}

export function SectionHead({
  title,
  lead,
  align = 'left',
  children,
}: {
  title: ReactNode;
  lead?: ReactNode;
  /** `wide` drops the measure cap — for a lead that sits in its own column. */
  align?: 'left' | 'wide';
  children?: ReactNode;
}) {
  return (
    <header className={`${styles.head} ${align === 'wide' ? styles.headWide : ''}`}>
      <h2 className={styles.title}>{title}</h2>
      {lead && <p className={styles.lead}>{lead}</p>}
      {children}
    </header>
  );
}

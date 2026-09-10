import type {ReactNode} from 'react';
import styles from './ModeTable.module.css';

export type ModeColumn = {
  /** Column heading, e.g. "Add". */
  title: string;
  /** Screenshot of the result in this mode. */
  image: string;
  /** One line under the image — the dialog tab or the chained method. */
  code?: string;
  /** What happens in this mode. */
  description?: ReactNode;
};

type ModeTableProps = {
  columns: ModeColumn[];
};

/**
 * Side-by-side results of one feature in each of its modes (Add / New /
 * Remove, or thin walls in the same three) — the same base part in every
 * column so only the mode differs.
 */
export function ModeTable({columns}: ModeTableProps) {
  return (
    <div className={styles.wrap}>
      <div className={styles.grid} style={{gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))`}}>
        {columns.map((c) => (
          <div key={c.title} className={styles.cell}>
            <strong className={styles.title}>{c.title}</strong>
            <img src={c.image} alt={`${c.title} mode`} loading="lazy" />
            {c.code && <code className={styles.code}>{c.code}</code>}
            {c.description && <p className={styles.desc}>{c.description}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

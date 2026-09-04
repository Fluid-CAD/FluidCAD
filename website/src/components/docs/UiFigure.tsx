import type {ReactNode} from 'react';
import styles from './UiFigure.module.css';

export type UiMarker = {
  /** Callout number, matches the legend row. */
  n: number;
  /** Horizontal position in percent of the image width. */
  x: number;
  /** Vertical position in percent of the image height. */
  y: number;
  /** Legend title. */
  label: string;
  /** Legend body. */
  description?: ReactNode;
};

type UiFigureProps = {
  src: string;
  alt: string;
  markers?: UiMarker[];
  /** Optional caption under the image. */
  caption?: ReactNode;
};

/**
 * A UI screenshot with numbered callouts. The markers are positioned in
 * percent so they stay on the element at every viewport width, and the legend
 * repeats the numbers — the figure reads on its own even when the image is
 * unavailable.
 */
export function UiFigure({src, alt, markers = [], caption}: UiFigureProps) {
  return (
    <figure className={styles.figure}>
      <div className={styles.frame}>
        <img src={src} alt={alt} loading="lazy" />
        {markers.map((m) => (
          <span
            key={m.n}
            className={styles.marker}
            style={{left: `${m.x}%`, top: `${m.y}%`}}
            aria-hidden>
            {m.n}
          </span>
        ))}
      </div>
      {caption && <figcaption className={styles.caption}>{caption}</figcaption>}
      {markers.length > 0 && (
        <ol className={styles.legend}>
          {markers.map((m) => (
            <li key={m.n}>
              <span className={styles.legendNumber}>{m.n}</span>
              <div>
                <strong>{m.label}</strong>
                {m.description && <div className={styles.legendBody}>{m.description}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </figure>
  );
}

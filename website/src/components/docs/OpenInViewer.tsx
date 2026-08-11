import {IconCube} from '@tabler/icons-react';
import {useViewerLink} from './viewer-link';
import styles from './OpenInViewer.module.css';

type OpenInViewerProps = {
  /** Raw .fluid.js source, typically imported via `!!raw-loader!`. */
  code: string;
  /** Filename shown in the viewer's timeline; the tutorial's suggested name. */
  entry?: string;
  /** Button label override. */
  label?: string;
};

export function OpenInViewer({code, entry, label}: OpenInViewerProps) {
  const href = useViewerLink(code, entry);

  return (
    <a
      className={styles.button}
      href={href ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      aria-disabled={!href}>
      <IconCube size={18} stroke={1.75} aria-hidden />
      <span>{label ?? 'Open this model in the 3D viewer'}</span>
    </a>
  );
}

import {IconCube} from '@tabler/icons-react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {useViewerLink, type ViewerFiles} from './viewer-link';
import styles from './OpenInViewer.module.css';

type OpenInViewerProps = {
  /** Raw .fluid.js source, typically imported via `!!raw-loader!`. */
  code?: string;
  /**
   * A multi-file model: file name (path inside the source tree) → source,
   * names preserved in the link so imports between files resolve. Wins over
   * `code`; `entry` names the file to render first.
   */
  files?: ViewerFiles;
  /** Filename shown in the viewer's timeline; the tutorial's suggested name. */
  entry?: string;
  /** Id of a package in the viewer's package store (`/m/<id>`); wins over `code`. */
  packageId?: string;
  /** Button label override. */
  label?: string;
};

export function OpenInViewer({code, files, entry, packageId, label}: OpenInViewerProps) {
  const {siteConfig} = useDocusaurusContext();
  const {fluidcadViewerUrl} = siteConfig.customFields as {
    fluidcadViewerUrl: string;
  };
  const codeHref = useViewerLink(files ?? code ?? '', entry);
  const href = packageId ? `${fluidcadViewerUrl}/m/${packageId}` : files || code ? codeHref : null;

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

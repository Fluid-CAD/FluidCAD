import {useEffect, useRef, useState} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {IconPlayerPlayFilled} from '@tabler/icons-react';
import {useViewerLink} from './viewer-link';
import styles from './ViewerEmbed.module.css';

type ViewerEmbedProps = {
  /** Raw .fluid.js source, typically imported via `!!raw-loader!`. */
  code: string;
  /** Filename shown in the viewer's timeline; the tutorial's suggested name. */
  entry?: string;
};

/**
 * Click-to-render viewer embed. The iframe shows the real viewer with an
 * empty scene (bare URL, no code fragment) behind a play overlay; playing
 * navigates the iframe to the fragment link so the model renders inline —
 * the engine is already warm from the empty-scene boot.
 *
 * The viewer needs SharedArrayBuffer, so inline embedding requires this page
 * to be cross-origin isolated (COOP/COEP in static/_headers). When it isn't
 * (e.g. Safari, which lacks COEP: credentialless), the facade stays a static
 * placeholder and play opens the viewer in a new tab.
 */
export function ViewerEmbed({code, entry}: ViewerEmbedProps) {
  const {siteConfig} = useDocusaurusContext();
  const href = useViewerLink(code, entry);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [isolated, setIsolated] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setIsolated(window.crossOriginIsolated === true);
  }, []);

  const handlePlay = () => {
    if (!href) {
      return;
    }
    if (isolated && frameRef.current) {
      frameRef.current.src = href;
      setPlaying(true);
    } else {
      window.open(href, '_blank', 'noopener');
    }
  };

  const {fluidcadViewerUrl} = siteConfig.customFields as {
    fluidcadViewerUrl: string;
  };

  return (
    <div className={styles.embed}>
      {isolated ? (
        <iframe
          ref={frameRef}
          className={styles.frame}
          src={`${fluidcadViewerUrl}/`}
          title="FluidCAD viewer"
          allow="cross-origin-isolated; fullscreen"
        />
      ) : (
        <div className={styles.emptyScene} aria-hidden />
      )}
      {!playing && (
        <button
          type="button"
          className={styles.overlay}
          onClick={handlePlay}
          disabled={!href}
          aria-label="Render this model in the 3D viewer">
          <span className={styles.playButton}>
            <IconPlayerPlayFilled size={26} aria-hidden />
          </span>
          <span className={styles.hint}>
            Render this model in your browser — no install needed
          </span>
        </button>
      )}
    </div>
  );
}

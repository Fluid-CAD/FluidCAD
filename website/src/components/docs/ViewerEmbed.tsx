import {useEffect, useRef, useState} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import {IconPlayerPlayFilled} from '@tabler/icons-react';
import {useViewerLink} from './viewer-link';
import styles from './ViewerEmbed.module.css';

type ViewerEmbedProps = {
  /** Raw .fluid.js source, typically imported via `!!raw-loader!`. */
  code?: string;
  /** Filename shown in the viewer's timeline; the tutorial's suggested name. */
  entry?: string;
  /**
   * Id of a package uploaded to the viewer's package store (`/m/<id>`), for
   * multi-file models or when the source should not travel in the URL.
   * Takes precedence over `code`.
   */
  packageId?: string;
  /**
   * Still image shown behind the play button instead of the idle viewer.
   * With a poster nothing loads until the reader presses play, so a page can
   * carry one embed per step without booting an engine per embed.
   */
  poster?: string;
  /** Alt text for the poster. */
  alt?: string;
};

/**
 * Click-to-render viewer embed. Without a poster, the iframe shows the real
 * viewer with an empty scene (bare URL, no model) behind a play overlay;
 * playing navigates the iframe to the model link so it renders inline — the
 * engine is already warm from the empty-scene boot. With a poster, the image
 * stands in for the idle viewer and the iframe is created on play.
 *
 * The viewer needs SharedArrayBuffer, so inline embedding requires this page
 * to be cross-origin isolated (COOP/COEP in static/_headers). When it isn't
 * (e.g. Safari, which lacks COEP: credentialless), the facade stays static
 * and play opens the viewer in a new tab.
 */
export function ViewerEmbed({code, entry, packageId, poster, alt}: ViewerEmbedProps) {
  const {siteConfig} = useDocusaurusContext();
  const {fluidcadViewerUrl} = siteConfig.customFields as {
    fluidcadViewerUrl: string;
  };
  const codeHref = useViewerLink(code ?? '', entry);
  const href = packageId ? `${fluidcadViewerUrl}/m/${packageId}` : code ? codeHref : null;
  const posterUrl = useBaseUrl(poster ?? '');
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
    if (isolated) {
      setPlaying(true);
      if (frameRef.current) {
        frameRef.current.src = href;
      }
    } else {
      window.open(href, '_blank', 'noopener');
    }
  };

  // With a poster the iframe only exists once playing; without one it boots
  // the idle viewer straight away so play is instant.
  const showFrame = isolated && (!poster || playing);

  return (
    <div className={styles.embed}>
      {showFrame ? (
        <iframe
          ref={frameRef}
          className={styles.frame}
          src={poster ? href ?? undefined : `${fluidcadViewerUrl}/`}
          title="FluidCAD viewer"
          allow="cross-origin-isolated; fullscreen"
        />
      ) : poster ? (
        <img className={styles.poster} src={posterUrl} alt={alt ?? ''} />
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

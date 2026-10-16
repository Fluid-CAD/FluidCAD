import {useEffect, useState} from 'react';
import styles from './YouTubeVideo.module.css';

type YouTubeVideoProps = {
  /** The id from the watch URL: `youtube.com/watch?v=<id>`. */
  id: string;
  title: string;
};

/**
 * A responsive 16:9 YouTube player.
 *
 * The docs pages are cross-origin isolated (COEP: credentialless, see
 * static/_headers), which blocks a plain YouTube iframe since YouTube sends no
 * COEP header. A `credentialless` iframe is exempt, so that is what renders
 * where the browser supports it (Chromium) or where the page is not isolated
 * at all (Safari). Elsewhere (Firefox) the thumbnail links out to YouTube.
 */
export function YouTubeVideo({id, title}: YouTubeVideoProps) {
  const [canEmbed, setCanEmbed] = useState(false);

  useEffect(() => {
    setCanEmbed(
      window.crossOriginIsolated !== true || 'credentialless' in HTMLIFrameElement.prototype,
    );
  }, []);

  return (
    <div className={styles.video}>
      {canEmbed ? (
        <iframe
          src={`https://www.youtube.com/embed/${id}`}
          title={title}
          // Must be on the element before it navigates; React sets it at creation.
          {...{credentialless: ''}}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      ) : (
        <a
          className={styles.facade}
          href={`https://www.youtube.com/watch?v=${id}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${title} (opens on YouTube)`}>
          <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" />
          <span className={styles.play} aria-hidden />
        </a>
      )}
    </div>
  );
}

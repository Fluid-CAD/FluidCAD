import {useEffect, useRef, useState} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {useColorMode} from '@docusaurus/theme-common';
import {ViewerEmbed} from '@site/src/lib/viewer-embed';
import type {HeroModel} from './models';
import styles from './HeroViewport.module.css';

/**
 * Why the frame is or isn't there.
 *
 * `checking` lasts one paint: `crossOriginIsolated` is a browser fact, so it
 * cannot be known during the server render.
 */
type Gate = 'checking' | 'boot' | 'held' | 'unsupported';

type Props = {
  model: HeroModel;
  className?: string;
};

/**
 * Booting the viewer means fetching the OpenCascade kernel — tens of
 * megabytes. Worth it on a capable connection, rude on a metered one, so the
 * automatic boot is gated and a metered visitor is asked first.
 */
function connectionLooksCapable(): boolean {
  const connection = (navigator as {connection?: {saveData?: boolean; effectiveType?: string}}).connection;
  if (!connection) {
    return true;
  }
  // Only the explicit signals. `effectiveType` is a rolling RTT estimate that
  // reads "3g" on plenty of fine connections, localhost included, so gating on
  // "4g" would hold the engine back from most visitors.
  return !connection.saveData && connection.effectiveType !== 'slow-2g' && connection.effectiveType !== '2g';
}

/**
 * The hero's scene: the real engine, building the real model, and then
 * nothing. No still in front of it while it loads, and no feature-tree walk
 * once it has — the viewer says "Loading engine…", then "Building model…",
 * then hands over a finished part the visitor can turn.
 */
export default function HeroViewport({model, className}: Props) {
  const {siteConfig} = useDocusaurusContext();
  const {colorMode} = useColorMode();
  const {fluidcadViewerUrl, fluidcadVersion} = siteConfig.customFields as {
    fluidcadViewerUrl: string;
    fluidcadVersion: string;
  };

  const frameRef = useRef<HTMLIFrameElement>(null);
  const embedRef = useRef<ViewerEmbed | null>(null);

  const [gate, setGate] = useState<Gate>('checking');
  /** Bumped every time the frame reports ready — a reload re-sends the model. */
  const [readyEpoch, setReadyEpoch] = useState(0);
  const [failed, setFailed] = useState(false);

  // The viewer needs SharedArrayBuffer, so it needs this page to be
  // cross-origin isolated. Where it is, the frame goes in on the first client
  // paint rather than at idle: what it paints while the engine arrives is the
  // viewer's own "Loading engine…", which is the hero's opening frame, not a
  // cost to defer.
  useEffect(() => {
    if (window.crossOriginIsolated !== true) {
      setGate('unsupported');
      return;
    }
    setGate(connectionLooksCapable() ? 'boot' : 'held');
  }, []);

  const booted = gate === 'boot';

  // Protocol wiring. The frame boots an empty scene; the first model arrives
  // over the channel, and every switch after it does too — so the engine is
  // fetched and warmed exactly once.
  useEffect(() => {
    const frame = frameRef.current;
    if (!booted || !frame) {
      return undefined;
    }
    const embed = new ViewerEmbed(frame, fluidcadViewerUrl);
    embedRef.current = embed;

    // The model itself is sent by the effect below, which runs as soon as
    // `ready` flips — one load, not two racing each other.
    const offReady = embed.on('ready', (event) => {
      // No viewport means no WebGL in the frame: the engine still runs, but
      // there is nothing to show.
      if (!event.viewport) {
        setFailed(true);
        return;
      }
      setReadyEpoch((epoch) => epoch + 1);
    });
    const offScene = embed.on('scene', (event) => {
      if (event.reason === 'load' && event.compileError) {
        setFailed(true);
      }
    });
    const offError = embed.on('error', () => setFailed(true));

    return () => {
      offReady();
      offScene();
      offError();
      embed.dispose();
      embedRef.current = null;
      setReadyEpoch(0);
    };
  }, [booted, fluidcadViewerUrl]);

  // The model, and every switch after it.
  useEffect(() => {
    if (readyEpoch === 0) {
      return;
    }
    embedRef.current?.load({files: model.files, entry: model.entry});
  }, [model, readyEpoch]);

  useEffect(() => {
    if (readyEpoch > 0) {
      embedRef.current?.setTheme(colorMode === 'dark' ? 'dark' : 'light');
    }
  }, [colorMode, readyEpoch]);

  // The theme is in the URL only to avoid a flash on first paint; every later
  // change goes over the channel. Putting it in `src` reactively would
  // navigate the frame and throw the warm engine away.
  const bootTheme = useRef(colorMode === 'dark' ? 'dark' : 'light').current;
  // No furniture at all: no ground grid (the hero rules its own, and the
  // viewer's perspective one crossing it reads as noise), no world axes, and
  // no connector gizmos — an assembly's mates are built on connectors, and
  // drawn they cover the geometry the hero is here to show.
  //
  // `v` is the engine, and it has to be here rather than on the model: the
  // frame boots an empty scene and resolves its engine once, so a model that
  // arrives later over the channel gets whatever was resolved at boot. Left
  // off, that is `/engine/dev/` — a different build from the one every other
  // viewer link on this site pins, and one whose mate solver placed this
  // assembly's parts by their fallback transforms instead of their mates.
  const src = `${fluidcadViewerUrl}/#v=${fluidcadVersion}&chrome=none&theme=${bootTheme}&grid=0&axes=0&connectors=0`;

  return (
    <div className={`${styles.stage} ${className ?? ''}`}>
      {booted && !failed && (
        <iframe
          ref={frameRef}
          className={styles.frame}
          src={src}
          title="FluidCAD viewer"
          allow="cross-origin-isolated; fullscreen"
          tabIndex={-1}
        />
      )}

      {/* Nothing stands in for the engine while it loads: the frame says
          "Loading engine…" and then "Building model…" itself. These are the
          cases where there will be no frame to say anything. */}
      {failed && <p className={styles.notice}>The viewer didn’t start.</p>}
      {!failed && gate === 'unsupported' && (
        <p className={styles.notice}>The viewer can’t run in this browser.</p>
      )}
      {!failed && gate === 'held' && (
        <div className={styles.notice}>
          <p className={styles.noticeText}>
            The engine is a large download, so it isn’t fetched automatically on a metered
            connection.
          </p>
          <button type="button" className={styles.noticeAction} onClick={() => setGate('boot')}>
            Load the viewer
          </button>
        </div>
      )}
    </div>
  );
}

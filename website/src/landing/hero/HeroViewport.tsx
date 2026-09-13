import {useCallback, useEffect, useRef, useState} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {useColorMode} from '@docusaurus/theme-common';
import {ViewerEmbed} from '@site/src/lib/viewer-embed';
import type {HeroModel} from './models';
import styles from './HeroViewport.module.css';

/** Beat between replay steps, and the rest on the finished model before looping. */
const REPLAY_INTERVAL_MS = 950;
const REPLAY_HOLD_MS = 3000;
/** Let the finished model land before it rewinds and rebuilds itself. */
const REPLAY_START_DELAY_MS = 1100;

type Phase = 'poster' | 'booting' | 'live';

type Props = {
  model: HeroModel;
  /** Mount the feature tree beside the scene. */
  withTimeline: boolean;
  /** Pixels to slide the model left, clear of whatever the page overlays. */
  viewShiftX: number;
  /** Pixels to lift the model, clear of the band the page fades out. */
  viewShiftY: number;
  /** Room the page occupies inside the frame — the rail docks clear of it. */
  panelInset: {top: number; bottom: number};
  className?: string;
};

/**
 * Booting the viewer means fetching the OpenCascade kernel — tens of
 * megabytes. Worth it on a capable connection, rude on a metered one, so the
 * automatic boot is gated and everyone else keeps the still.
 */
function connectionLooksCapable(): boolean {
  const connection = (navigator as {connection?: {saveData?: boolean; effectiveType?: string}}).connection;
  if (!connection) {
    return true;
  }
  // Only the explicit signals. `effectiveType` is a rolling RTT estimate that
  // reads "3g" on plenty of fine connections, localhost included, so gating on
  // "4g" would leave most visitors looking at a still.
  return !connection.saveData && connection.effectiveType !== 'slow-2g' && connection.effectiveType !== '2g';
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function HeroViewport({model, withTimeline, viewShiftX, viewShiftY, panelInset, className}: Props) {
  const {siteConfig} = useDocusaurusContext();
  const {colorMode} = useColorMode();
  const {fluidcadViewerUrl} = siteConfig.customFields as {fluidcadViewerUrl: string};

  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const embedRef = useRef<ViewerEmbed | null>(null);
  const replayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Once the visitor grabs the model, the replay stops for good. */
  const releasedRef = useRef(false);
  const modelRef = useRef(model);
  modelRef.current = model;
  const shiftRef = useRef({x: viewShiftX, y: viewShiftY});
  shiftRef.current = {x: viewShiftX, y: viewShiftY};
  const insetRef = useRef(panelInset);
  insetRef.current = panelInset;

  const [supported, setSupported] = useState<boolean | null>(null);
  const [booted, setBooted] = useState(false);
  /** Bumped every time the frame reports ready — a reload re-sends the model. */
  const [readyEpoch, setReadyEpoch] = useState(0);
  const [phase, setPhase] = useState<Phase>('poster');
  const [failed, setFailed] = useState(false);

  // The viewer needs SharedArrayBuffer, so it needs this page to be
  // cross-origin isolated. Where it isn't, the stills are the whole story.
  useEffect(() => {
    setSupported(window.crossOriginIsolated === true);
  }, []);

  // Boot once the hero is actually on screen, at idle, and only when the
  // connection can take it.
  useEffect(() => {
    if (supported !== true || booted || !connectionLooksCapable()) {
      return undefined;
    }
    const stage = stageRef.current;
    if (!stage) {
      return undefined;
    }
    let idleHandle: number | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        observer.disconnect();
        const idle = (window as {requestIdleCallback?: (cb: () => void, o?: {timeout: number}) => number})
          .requestIdleCallback;
        idleHandle = idle
          ? idle(() => setBooted(true), {timeout: 2000})
          : window.setTimeout(() => setBooted(true), 400);
      },
      {rootMargin: '200px'},
    );
    observer.observe(stage);
    return () => {
      observer.disconnect();
      if (idleHandle !== null) {
        window.clearTimeout(idleHandle);
      }
    };
  }, [supported, booted]);

  const clearReplayTimer = useCallback(() => {
    if (replayTimer.current !== null) {
      clearTimeout(replayTimer.current);
      replayTimer.current = null;
    }
  }, []);

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
    setPhase('booting');

    // The model itself is sent by the effect below, which runs as soon as
    // `ready` flips — one load, not two racing each other.
    const offReady = embed.on('ready', (event) => {
      // No viewport means no WebGL in the frame: the engine still runs, but
      // there is nothing to cross-fade to. Stay on the still.
      if (!event.viewport) {
        setFailed(true);
        return;
      }
      setReadyEpoch((epoch) => epoch + 1);
    });
    const offScene = embed.on('scene', (event) => {
      if (event.reason !== 'load') {
        return;
      }
      if (event.compileError) {
        setFailed(true);
        return;
      }
      setPhase('live');
      // Re-assert the offset per scene: a new model brings a new fit, and an
      // assembly swaps the whole camera rig.
      embed.setViewOffset(shiftRef.current.x, shiftRef.current.y);
      embed.setPanelInset(insetRef.current);
      clearReplayTimer();
      if (modelRef.current.replay && !releasedRef.current && !prefersReducedMotion()) {
        replayTimer.current = setTimeout(() => {
          embed.replay({
            mode: 'play',
            intervalMs: REPLAY_INTERVAL_MS,
            holdMs: REPLAY_HOLD_MS,
            loop: true,
          });
        }, REPLAY_START_DELAY_MS);
      }
    });
    const offError = embed.on('error', () => setFailed(true));

    return () => {
      offReady();
      offScene();
      offError();
      clearReplayTimer();
      embed.dispose();
      embedRef.current = null;
      setReadyEpoch(0);
    };
    // `withTimeline` re-keys the iframe, so the bridge has to be rebuilt
    // against the new element.
  }, [booted, withTimeline, fluidcadViewerUrl, clearReplayTimer]);

  // The model, and every switch after it: back behind the still, rebuild,
  // cross-fade in again.
  useEffect(() => {
    if (readyEpoch === 0) {
      return;
    }
    clearReplayTimer();
    setPhase('booting');
    embedRef.current?.load({files: {[model.entry]: model.source}, entry: model.entry});
    // The model the visitor asked for is a fresh start for the replay.
    releasedRef.current = false;
  }, [model, readyEpoch, clearReplayTimer]);

  useEffect(() => {
    if (readyEpoch > 0) {
      embedRef.current?.setTheme(colorMode === 'dark' ? 'dark' : 'light');
    }
  }, [colorMode, readyEpoch]);

  // The page overlays its headline on the right of the frame; the model slides
  // left by the same measurement so nothing lands on top of it.
  useEffect(() => {
    if (readyEpoch > 0) {
      embedRef.current?.setViewOffset(viewShiftX, viewShiftY);
      embedRef.current?.setPanelInset(panelInset);
    }
  }, [viewShiftX, viewShiftY, panelInset, readyEpoch, phase]);

  // Hovering is reading: hold the build where it is. Grabbing the model is
  // taking over: stop the replay and hand the scene back whole.
  const pause = () => embedRef.current?.replay({mode: 'pause'});
  const resume = () => {
    if (!releasedRef.current) {
      embedRef.current?.replay({mode: 'resume'});
    }
  };
  const release = () => {
    if (releasedRef.current) {
      return;
    }
    releasedRef.current = true;
    clearReplayTimer();
    embedRef.current?.replay({mode: 'stop'});
  };

  // The theme is in the URL only to avoid a flash on first paint; every later
  // change goes over the channel. Putting it in `src` reactively would
  // navigate the frame and throw the warm engine away.
  const bootTheme = useRef(colorMode === 'dark' ? 'dark' : 'light').current;
  const src = `${fluidcadViewerUrl}/#chrome=none${withTimeline ? ',timeline' : ''}&theme=${bootTheme}&axes=0`;

  return (
    <div
      ref={stageRef}
      className={`${styles.stage} ${className ?? ''}`}
      style={
        {
          '--hero-shift-x': `${viewShiftX}px`,
          '--hero-shift-y': `${viewShiftY}px`,
          // The room the page has taken at the foot of the scene: the
          // switcher and the band under it. The dissolve is measured from
          // it, so it clears the controls without reaching the model.
          '--hero-band': `${panelInset.bottom}px`,
        } as React.CSSProperties
      }
      onPointerEnter={pause}
      onPointerLeave={resume}
      onPointerDown={release}>
      {booted && !failed && (
        <iframe
          ref={frameRef}
          key={withTimeline ? 'rail' : 'bare'}
          className={styles.frame}
          src={src}
          title="FluidCAD viewer"
          allow="cross-origin-isolated; fullscreen"
          tabIndex={-1}
        />
      )}
      <img
        src={model.poster}
        alt={model.posterAlt}
        className={styles.poster}
        data-hidden={phase === 'live' || undefined}
        width={1500}
        height={1000}
        fetchPriority="high"
        decoding="async"
      />
      <div
        className={`${styles.fade} ${panelInset.bottom > 0 ? styles.banded : ''}`}
        aria-hidden="true"
      />
    </div>
  );
}

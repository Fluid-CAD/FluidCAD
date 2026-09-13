import {useEffect, useState} from 'react';
import Link from '@docusaurus/Link';
import {usePluginData} from '@docusaurus/useGlobalData';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import type {DesktopRelease} from '../../../plugins/desktop-release';
import {Section} from '../Section';
import styles from './Get.module.css';

type PlatformId = 'mac' | 'windows' | 'linux';

/* No platform marks. Apple's and Microsoft's are unmistakable, and there is no
   equivalent for "Linux" that is not really one distribution's logo standing
   in for the rest — so the row carries the name and what it ships instead. */
const PLATFORMS: {id: PlatformId; name: string; detail: string}[] = [
  {id: 'mac', name: 'macOS', detail: 'Apple silicon, signed and notarized'},
  {id: 'windows', name: 'Windows', detail: '64-bit installer'},
  {id: 'linux', name: 'Linux', detail: 'AppImage and .deb, x86-64'},
];

/**
 * Which build this visitor wants, guessed from the browser.
 *
 * Only ever a guess, so it decides the *order* and nothing else: every
 * platform is on the page, and a wrong guess costs one glance rather than a
 * hunt through a menu. Resolved after mount because the server has no idea
 * who is asking.
 */
function detectPlatform(): PlatformId | null {
  const data = (navigator as {userAgentData?: {platform?: string}}).userAgentData;
  const hint = `${data?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent}`;
  if (/mac|iphone|ipad/i.test(hint)) {
    return 'mac';
  }
  if (/win/i.test(hint)) {
    return 'windows';
  }
  if (/linux|x11|cros/i.test(hint)) {
    return 'linux';
  }
  return null;
}

function megabytes(size: number): string {
  return `${Math.round(size / 1e5) / 10} MB`;
}

export default function Get() {
  const release = usePluginData('fluidcad-desktop-release') as DesktopRelease;
  const {siteConfig} = useDocusaurusContext();
  const {fluidcadVersion} = siteConfig.customFields as {fluidcadVersion: string};
  const [mine, setMine] = useState<PlatformId | null>(null);

  useEffect(() => setMine(detectPlatform()), []);

  // The visitor's own platform first, the rest in their usual order. Until
  // the guess resolves the server's order stands, so nothing shifts under a
  // pointer that is already moving.
  const ordered = mine
    ? [...PLATFORMS].sort((a, b) => Number(b.id === mine) - Number(a.id === mine))
    : PLATFORMS;

  return (
    <Section id="get" ground="sunken">
      <div className={styles.head}>
        <h2 className={styles.title}>Get FluidCAD</h2>
        <p className={styles.lead}>
          MIT licensed, and the whole thing is on GitHub: the kernel bindings, the app, the
          extensions and this site.
        </p>
      </div>

      <div className={styles.columns}>
        <div className={styles.desktop}>
          <h3 className={styles.columnTitle}>
            Desktop app
            {release.tag && <span className={styles.tag}>{release.tag}</span>}
          </h3>
          <ul className={styles.platforms}>
            {ordered.map((platform) => {
              const assets = release[platform.id];
              return (
                <li
                  key={platform.id}
                  className={styles.platform}
                  data-mine={platform.id === mine || undefined}>
                  <div className={styles.platformText}>
                    <span className={styles.platformName}>
                      {platform.name}
                      {platform.id === mine && <span className={styles.yours}>your machine</span>}
                    </span>
                    <span className={styles.platformDetail}>{platform.detail}</span>
                  </div>
                  <div className={styles.platformActions}>
                    {assets.length > 0 ? (
                      assets.map((asset) => (
                        <a key={asset.url} className={styles.download} href={asset.url}>
                          {asset.label}
                          <span className={styles.size}>{megabytes(asset.size)}</span>
                        </a>
                      ))
                    ) : (
                      <span className={styles.pending}>Build not published yet</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {ordered.every((p) => release[p.id].length === 0) && (
            <p className={styles.pendingNote}>
              The desktop builds are being cut now. Until they land on the release page, install the
              package and run <code>npx fluidcad serve</code>; it is the same engine and the same
              viewport, in a browser tab.{' '}
              <Link href={release.releasesUrl}>Watch the releases</Link>.
            </p>
          )}
        </div>

        <div className={styles.package}>
          <h3 className={styles.columnTitle}>
            Package
            <span className={styles.tag}>{fluidcadVersion}</span>
          </h3>
          <pre className={styles.install}>
            <code>
              <span className={styles.prompt}>$</span> npm i fluidcad{'\n'}
              <span className={styles.prompt}>$</span> npx fluidcad init{'\n'}
              <span className={styles.prompt}>$</span> npx fluidcad serve
            </code>
          </pre>
          <p className={styles.packageNote}>
            Installed per project, so the engine and your editor&rsquo;s type hints resolve from the
            same <code>node_modules</code> as the model.
          </p>
          <div className={styles.actions}>
            <Link className={styles.primary} to="/docs/getting-started">
              Read the getting started guide
            </Link>
            <Link className={styles.secondary} href="https://github.com/Fluid-CAD/FluidCAD">
              Browse the source
            </Link>
          </div>
          <p className={styles.ahead}>
            A browser version that needs no install is in progress. Today the engine already runs
            client-side in the viewer above.
          </p>
        </div>
      </div>
    </Section>
  );
}

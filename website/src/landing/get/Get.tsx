import { useEffect, useState } from 'react'
import Link from '@docusaurus/Link'
import {
  IconBrandApple,
  IconBrandWindows,
  IconBrandVscode,
  IconTerminal2
} from '@tabler/icons-react'
import { usePluginData } from '@docusaurus/useGlobalData'
import useDocusaurusContext from '@docusaurus/useDocusaurusContext'
import type { DesktopRelease } from '../../../plugins/desktop-release'
import { Section } from '../Section'
import styles from './Get.module.css'

type PlatformId = 'mac' | 'windows' | 'linux'

// Original Tux by Larry Ewing and The GIMP; see static/img/landing/ATTRIBUTION.md.
function LinuxLogo({ size = 36 }: { size?: number; stroke?: number }) {
  return (
    <img
      className={styles.linuxLogo}
      src="/img/landing/linux-tux.png"
      width={size}
      height={size}
      alt=""
    />
  )
}

const PLATFORM_ICONS = { mac: IconBrandApple, windows: IconBrandWindows, linux: LinuxLogo }
const PLATFORMS: { id: PlatformId; name: string; detail: string }[] = [
  { id: 'mac', name: 'macOS', detail: 'Apple silicon, signed and notarized' },
  { id: 'windows', name: 'Windows', detail: '64-bit installer' },
  { id: 'linux', name: 'Linux', detail: 'AppImage and .deb, x86-64' }
]

/**
 * Which build this visitor wants, guessed from the browser.
 *
 * Only ever a guess, so it decides the *order* and nothing else: every
 * platform is on the page, and a wrong guess costs one glance rather than a
 * hunt through a menu. Resolved after mount because the server has no idea
 * who is asking.
 */
function detectPlatform(): PlatformId | null {
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData
  const hint = `${data?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent}`
  if (/mac|iphone|ipad/i.test(hint)) {
    return 'mac'
  }
  if (/win/i.test(hint)) {
    return 'windows'
  }
  if (/linux|x11|cros/i.test(hint)) {
    return 'linux'
  }
  return null
}

function megabytes(size: number): string {
  return `${Math.round(size / 1e5) / 10} MB`
}

export default function Get() {
  const release = usePluginData('fluidcad-desktop-release') as DesktopRelease
  const { siteConfig } = useDocusaurusContext()
  const { fluidcadVersion } = siteConfig.customFields as { fluidcadVersion: string }
  const [mine, setMine] = useState<PlatformId | null>(null)

  useEffect(() => setMine(detectPlatform()), [])

  // The visitor's own platform first, the rest in their usual order. Until
  // the guess resolves the server's order stands, so nothing shifts under a
  // pointer that is already moving.
  const ordered = mine
    ? [...PLATFORMS].sort((a, b) => Number(b.id === mine) - Number(a.id === mine))
    : PLATFORMS

  return (
    <Section id="get" ground="sunken">
      <div className={styles.head}>
        <h2 className={styles.title}>Download</h2>
        <p className={styles.lead}>
          Your models, on your machine. Get the desktop app for macOS, Windows or Linux. Free and
          open source, under the MIT license.
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
              const assets = release[platform.id]
              const PlatformIcon = PLATFORM_ICONS[platform.id]
              return (
                <li
                  key={platform.id}
                  className={styles.platform}
                  data-mine={platform.id === mine || undefined}
                >
                  <PlatformIcon size={36} stroke={1.5} aria-hidden="true" />
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
              )
            })}
          </ul>
          {ordered.every((p) => release[p.id].length === 0) && (
            <p className={styles.pendingNote}>
              The desktop builds are being cut now. Until they land on the release page, install the
              package and run <code>npx fluidcad serve</code>; it is the same engine and the same
              viewport, in a browser tab. <Link href={release.releasesUrl}>Watch the releases</Link>
              .
            </p>
          )}
        </div>

        <div className={styles.below}>
          <h3 className={styles.otherTitle}>Other installation options</h3>
          <div className={styles.extensions}>
            <h4 className={styles.columnTitle}>Editor extensions</h4>
            <p className={styles.packageNote}>
              Keep the model beside your code in the editor you use every day.
            </p>
            <div className={styles.actions}>
              <Link
                className={styles.secondary}
                href="https://marketplace.visualstudio.com/items?itemName=FluidCAD.fluidcad"
              >
                <IconBrandVscode size={20} aria-hidden="true" /> VS Code
              </Link>
              <Link className={styles.secondary} to="/docs/installation#editor-setup">
                <IconTerminal2 size={20} aria-hidden="true" /> Neovim
              </Link>
            </div>
          </div>
          <div className={styles.package}>
            <h4 className={styles.columnTitle}>
              Install with npm
              <span className={styles.tag}>{fluidcadVersion}</span>
            </h4>
            <pre className={styles.install}>
              <code>
                <span className={styles.prompt}>$</span> npm i fluidcad{'\n'}
                <span className={styles.prompt}>$</span> npx fluidcad init{'\n'}
                <span className={styles.prompt}>$</span> npx fluidcad serve
              </code>
            </pre>
            <p className={styles.packageNote}>
              Installed per project, so the engine and your editor&rsquo;s type hints resolve from
              the same <code>node_modules</code> as the model.
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
      </div>
    </Section>
  )
}

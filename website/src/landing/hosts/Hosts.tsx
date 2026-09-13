import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import {Section, SectionHead} from '../Section';
import styles from './Hosts.module.css';

type Host = {
  id: string;
  name: string;
  line: ReactNode;
  /** What you type. Shown in the mono the app writes in. Omitted on the row
   *  that has nothing to type — the desktop app is a download, not a command. */
  command?: string;
  href?: string;
  hrefLabel?: string;
  /** The agent row is the one most people have not seen before. */
  wide?: boolean;
};

/**
 * One server, several front doors.
 *
 * The honest shape of this section is a list, not a grid of tiles: these are
 * not six products, they are six ways into the same running workspace, and a
 * list is what says that. Ordered by how most people arrive.
 */
const HOSTS: Host[] = [
  {
    id: 'desktop',
    name: 'The desktop app',
    line: (
      <>
        macOS, Windows and Linux. Viewport, tools, feature tree and editor in one window, with the
        engine bundled.
      </>
    ),
    href: '#get',
    hrefLabel: 'Downloads',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    line: (
      <>
        The scene beside the file. Click the gutter to drop a <code>breakpoint()</code>, pick regions
        and edges in the viewport, and the source updates as you do.
      </>
    ),
    command: 'FluidCAD: Show FluidCAD Scene',
    href: 'https://marketplace.visualstudio.com/items?itemName=FluidCAD.fluidcad',
    hrefLabel: 'Marketplace',
  },
  {
    id: 'neovim',
    name: 'Neovim',
    line: (
      <>
        The same server, driven from the editor you already live in. The plugin starts it when you
        open a model.
      </>
    ),
    command: ':FluidCadOpenBrowser',
    href: '/docs/getting-started/editor-setup',
    hrefLabel: 'Editor setup',
  },
  {
    id: 'cli',
    name: 'Any other editor',
    line: <>Run the server yourself and keep the viewport in a browser tab. It rebuilds on save.</>,
    command: 'npx fluidcad serve',
    href: '/docs/guides/cli',
    hrefLabel: 'CLI reference',
  },
  {
    id: 'library',
    name: 'A build step',
    line: (
      <>
        The engine is an npm package, so a model is something CI can build. Write STEP, STL or a PNG
        of the viewport without opening a window.
      </>
    ),
    command: 'npx fluidcad export step',
    href: '/docs/guides/export',
    hrefLabel: 'Export',
  },
  {
    id: 'mcp',
    name: 'An agent',
    line: (
      <>
        An MCP server ships with the package. An agent connected to it drives the workspace you have
        open: it reads and edits the source, recomputes, takes screenshots, measures geometry,
        inspects a face, and looks up the API. It is how a model gets built by conversation without
        anyone giving up the file.
      </>
    ),
    command: 'npx fluidcad mcp',
    href: '/docs/guides/cli#fluidcad-mcp',
    hrefLabel: 'MCP setup',
    wide: true,
  },
];

export default function Hosts() {
  return (
    <Section>
      <SectionHead
        title="It runs where you work"
        lead="One server holds the model. Everything below is a way into it, and they can all be open at once: edit in Neovim, watch the scene in a browser, let an agent measure a face while you do."
      />

      <ul className={styles.list}>
        {HOSTS.map((host) => (
          <li key={host.id} className={`${styles.row} ${host.wide ? styles.rowWide : ''}`}>
            <h3 className={styles.name}>{host.name}</h3>
            <p className={styles.line}>{host.line}</p>
            <p className={styles.command}>
              {host.command && <code>{host.command}</code>}
              {host.href &&
                // A same-page hash is not a route change, so it is a plain
                // anchor: Docusaurus' <Link> would treat it as a navigation
                // and its link checker reports the target as missing.
                (host.href.startsWith('#') ? (
                  <a className={styles.link} href={host.href}>
                    {host.hrefLabel}
                  </a>
                ) : (
                  <Link className={styles.link} to={host.href}>
                    {host.hrefLabel}
                  </Link>
                ))}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

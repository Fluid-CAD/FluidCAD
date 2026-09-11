import type {ReactNode} from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

const RELEASES = 'https://github.com/Fluid-CAD/FluidCAD/releases';

function useFluidcadVersion(): string {
  const {siteConfig} = useDocusaurusContext();
  const {fluidcadVersion} = siteConfig.customFields as {fluidcadVersion: string};
  return fluidcadVersion;
}

type DownloadLinkProps = {
  /**
   * The artifact name after `FluidCAD-<version>-`, as electron-builder's
   * `artifactName` in shell/electron-builder.yml produces it:
   * `win-x64.exe`, `linux-x86_64.AppImage`, `linux-amd64.deb`,
   * `mac-arm64.dmg`, `mac-arm64.zip`.
   */
  asset: string;
};

/**
 * A direct link to one installer of the release the docs were built against.
 * The version comes from the root package.json through `customFields`, so a
 * release bump moves every link with it; the website deploys when the release
 * is published, which is when these URLs start resolving.
 */
export function DownloadLink({asset}: DownloadLinkProps) {
  const version = useFluidcadVersion();
  const file = `FluidCAD-${version}-${asset}`;
  return (
    <a href={`${RELEASES}/download/v${version}/${file}`}>
      <code>{file}</code>
    </a>
  );
}

/** The release page of the version the docs were built against. */
export function ReleaseLink({children}: {children?: ReactNode}) {
  const version = useFluidcadVersion();
  return <a href={`${RELEASES}/tag/v${version}`}>{children ?? `FluidCAD ${version}`}</a>;
}

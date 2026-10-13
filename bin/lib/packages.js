/**
 * Shared by `install`, `remove` and `packages`: the compiled server classes
 * they wrap, and how a package is printed. The rules — roots, inspection,
 * installs, pins — live in the server's `server/src/packages/`, typed and
 * tested there; these commands are the terminal around them.
 */

/** The server's package classes, imported lazily: the rest of the CLI doesn't need them at startup. */
export async function loadPackages() {
  const [archive, installer, manifests, pins, roots, project, preferences, names] = await Promise.all([
    import('../../server/dist/packages/package-archive.js'),
    import('../../server/dist/packages/package-installer.js'),
    import('../../server/dist/packages/package-manifests.js'),
    import('../../server/dist/packages/package-pins.js'),
    import('../../server/dist/packages/package-roots.js'),
    import('../../server/dist/packages/project-packages.js'),
    import('../../server/dist/preferences.js'),
    import('../../server/dist/packages/package-name.js'),
  ]);
  return {
    PackageArchive: archive.PackageArchive,
    PackageArchiveError: archive.PackageArchiveError,
    PackageInstaller: installer.PackageInstaller,
    PackageInstallError: installer.PackageInstallError,
    PackageManifests: manifests.PackageManifests,
    PackagePins: pins.PackagePins,
    PackagePinError: pins.PackagePinError,
    PackageRoots: roots.PackageRoots,
    ProjectPackages: project.ProjectPackages,
    loadPreferences: preferences.loadPreferences,
    PackageName: names.PackageName,
  };
}

/**
 * A refusal one of the package classes (or, for an install from the hub, the
 * hub classes) words for the user: print it and exit 1. Anything else is
 * rethrown.
 */
export function exitOnRefusal(err, mods) {
  const refusals = [mods.PackageArchiveError, mods.PackageInstallError, mods.PackagePinError, mods.HubInstallError, mods.HubConfigError, mods.HubRequestError].filter(Boolean);
  if (refusals.some((type) => err instanceof type)) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

/**
 * What `fluidcad install` prints for a package: one line, with what
 * happened, what the package holds and what happened to the project's pin
 * (`✓ Installed @acme/kit@0.2.0 into your library · 5 features, 5 parts,
 * 1 assembly · pinned in fluidcad.json`), then a short line per warning.
 */
export class InstallLine {
  static print(head, manifest, pin, warnings = []) {
    console.log(`✓ ${[head, InstallLine.contents(manifest), InstallLine.pinned(pin)].filter(Boolean).join(' · ')}`);
    for (const warning of warnings) {
      console.log(`  ! ${warning}`);
    }
  }

  /** What an install did, as the head of its line; `where` is "your library" or "this project's packages folder". */
  static head(result, where) {
    const at = `${result.name}@${result.version}`;
    switch (result.status) {
      case 'unchanged':
        return `${at} is already in ${where}`;
      case 'replaced':
        return `Replaced ${at} in ${where}`;
      default:
        return `Installed ${at} into ${where}`;
    }
  }

  /** `5 features, 5 parts, 1 assembly`, a count of zero left out; empty for a manifest that holds nothing or can't be read. */
  static contents(manifest) {
    if (!manifest) {
      return '';
    }
    const parts = manifest.parts ?? [];
    const assemblies = parts.filter((p) => p.kind === 'assembly').length;
    const counts = [
      [manifest.features?.length ?? 0, 'feature', 'features'],
      [parts.length - assemblies, 'part', 'parts'],
      [assemblies, 'assembly', 'assemblies'],
    ];
    return counts.filter(([n]) => n > 0).map(([n, noun, plural]) => count(n, noun, plural)).join(', ');
  }

  /** What an install did to the project's pin; empty when it pinned nothing. */
  static pinned(pin) {
    if (pin === 'pinned') {
      return 'pinned in fluidcad.json';
    }
    if (pin === 'unchanged') {
      return 'already pinned in fluidcad.json';
    }
    return '';
  }
}

/** The "New packages go to" setting; the project only when there is one. */
export async function preferredTarget(mods, project) {
  const preferred = (await mods.loadPreferences()).packageInstallTarget;
  return preferred === 'project' && project ? 'project' : 'library';
}

/** One installed package on one line: name, version, contents, size. */
export function describeInstalled(entry) {
  if (!entry.manifest) {
    return `${entry.name} ${entry.version}  (${entry.problem})`;
  }
  const { features, parts } = entry.manifest;
  const contents = [count(features?.length ?? 0, 'feature'), count(parts?.length ?? 0, 'part')].join(', ');
  return `${entry.name} ${entry.version}  ${contents}, ${size(entry.bytes)}`;
}

/** "your library" or "this project's packages folder", with the path. */
export function describeTarget(mods, target, directory) {
  return `${mods.PackageInstaller.describe(target)} (${directory})`;
}

export function count(n, noun, plural = `${noun}s`) {
  return `${n} ${n === 1 ? noun : plural}`;
}

export function size(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

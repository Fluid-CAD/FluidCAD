import { confirm, isInteractive } from './prompt.js';

/**
 * Shared by `install`, `remove` and `packages`: the compiled server classes
 * they wrap, and how a package is printed. The rules — roots, inspection,
 * installs, pins — live in the server's `server/src/packages/`, typed and
 * tested there; these commands are the terminal around them.
 */

/** The server's package classes, imported lazily: the rest of the CLI doesn't need them at startup. */
export async function loadPackages() {
  const [archive, installer, pins, roots, project, preferences] = await Promise.all([
    import('../../server/dist/packages/package-archive.js'),
    import('../../server/dist/packages/package-installer.js'),
    import('../../server/dist/packages/package-pins.js'),
    import('../../server/dist/packages/package-roots.js'),
    import('../../server/dist/packages/project-packages.js'),
    import('../../server/dist/preferences.js'),
  ]);
  return {
    PackageArchive: archive.PackageArchive,
    PackageArchiveError: archive.PackageArchiveError,
    PackageInstaller: installer.PackageInstaller,
    PackageInstallError: installer.PackageInstallError,
    PackagePins: pins.PackagePins,
    PackagePinError: pins.PackagePinError,
    PackageRoots: roots.PackageRoots,
    ProjectPackages: project.ProjectPackages,
    loadPreferences: preferences.loadPreferences,
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
 * The consent summary (research §3, "The install flow"): what the package
 * is, what it needs, and what installing it means. `notes` are what the
 * hub's resolution has to say (a yanked or unpublished version, an older
 * version picked for this engine), shown with the warnings.
 */
export function printConsentSummary(inspection, notes = []) {
  const { manifest, warnings, bytes, integrity } = inspection;
  console.log(`${manifest.name} ${manifest.version}${manifest.description ? ` — ${manifest.description}` : ''}`);
  const features = manifest.features.map((f) => (f.meta?.label ? `${f.id} (${f.meta.label})` : f.id));
  const parts = manifest.parts.map((p) => (p.kind === 'assembly' ? `${p.exportName} (assembly)` : p.exportName));
  console.log(`  ${count(features.length, 'feature')}${features.length ? `: ${features.join(', ')}` : ''}`);
  console.log(`  ${count(parts.length, 'part')}${parts.length ? `: ${parts.join(', ')}` : ''}`);
  console.log(`  needs FluidCAD ${manifest.minEngine} or newer (packed on ${manifest.engine})`);
  console.log(`  ${count(manifest.files.length + 1, 'file')}, ${size(bytes)}, ${integrity}`);
  for (const note of notes) {
    console.log(`  ! ${note}`);
  }
  for (const warning of warnings) {
    console.log(`  ! ${warning.message}`);
  }
  console.log("A package's code runs in the FluidCAD engine with your permissions. Install only packages you trust.");
}

/** Asks before anything is installed; without a terminal, only `--yes` consents. */
export async function consented(question = 'Install it?') {
  if (!isInteractive()) {
    console.error('Pass --yes to install without being asked.');
    return false;
  }
  return confirm(question);
}

/** What an install did, on one line. */
export function installedLine(mods, result) {
  const where = describeTarget(mods, result.target, result.directory);
  switch (result.status) {
    case 'unchanged':
      return `${result.name} ${result.version} is already in ${where}, with the same contents: nothing changed.`;
    case 'replaced':
      return `Replaced ${result.name} ${result.version} in ${where}.`;
    default:
      return `Installed ${result.name} ${result.version} into ${where}.`;
  }
}

/** What an install did to the project's pin. */
export function printPin(pin, name, version, from = null) {
  if (pin === 'pinned') {
    console.log(`Pinned ${name} ${version} in this project's fluidcad.json${from === 'library' ? ' (it loads from your library)' : ''}.`);
  } else if (pin === 'unchanged') {
    console.log(`This project already pins ${name} ${version}.`);
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

export function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
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

import { describeInstalled, exitOnRefusal, loadPackages } from '../lib/packages.js';

/**
 * `fluidcad packages`: what your library holds, and in a project, what its
 * packages/ folder holds and where each package it pins is installed.
 */
async function runPackages() {
  const mods = await loadPackages();
  const cwd = process.cwd();
  const project = mods.PackagePins.isProject(cwd) ? cwd : null;
  try {
    const overview = mods.ProjectPackages.overview(project);
    printRoot('Your library', overview.library);
    if (overview.project) {
      printRoot("This project's packages folder", overview.project);
      console.log('Pinned in fluidcad.json:');
      if (overview.pinsProblem) {
        console.log(`  ${overview.pinsProblem}`);
      } else if (overview.pins.length === 0) {
        console.log('  (none)');
      }
      for (const pin of overview.pins) {
        const where = pin.availability === 'missing' ? 'not installed' : pin.availability === 'library' ? 'from your library' : 'from this project';
        console.log(`  ${pin.name} ${pin.version}  ${where}`);
      }
    }
  } catch (err) {
    exitOnRefusal(err, mods);
  }
}

function printRoot(title, root) {
  console.log(`${title}: ${root.path}`);
  if (root.packages.length === 0) {
    console.log('  (empty)');
  }
  for (const entry of root.packages) {
    console.log(`  ${describeInstalled(entry)}`);
  }
}

export function registerPackagesCommand(program) {
  program
    .command('packages')
    .description('List the packages in your library, and in a project its own copies and pins')
    .action(() => {
      runPackages().catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}

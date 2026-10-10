/**
 * `fluidcad publish` uploaded a model to the abandoned first hub, with its
 * own credentials (`~/.config/fluidcad`) and API (`/api/publish`). Both are
 * gone: `fluidcad login` now signs in to the new hub, which publishes
 * packages, not models. Until the command is rewritten for packages, it
 * says so instead of failing halfway.
 */
function runPublish() {
  console.error('`fluidcad publish` is being rewritten for the new FluidCAD hub and is not available in this version.');
  console.error('`fluidcad pack` still makes a package archive you can share and install with `fluidcad install`.');
  process.exit(1);
}

export function registerPublishCommand(program) {
  program
    .command('publish')
    .description('Publish to the FluidCAD hub (being rewritten for packages)')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(runPublish);
}

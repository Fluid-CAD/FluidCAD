import { resolve } from 'path';
import { getHubUrl, readCredentials } from '../lib/config.js';
import { HubClient } from '../lib/api-client.js';
import { findEntry, readPackageVersion, readWorkspacePackage } from '../lib/workspace.js';
import { readModelId, writeModelId } from '../lib/model-config.js';
import { openBrowser } from '../lib/browser.js';

async function runPublish(opts) {
  const creds = readCredentials();
  if (!creds) {
    throw new Error('Not logged in. Run `fluidcad login` first.');
  }
  const hubUrl = getHubUrl(opts.hub || creds.hubUrl);

  const workspace = resolve(opts.workspace ?? process.cwd());
  const entry = findEntry(workspace, opts.entry);

  // Prefills from the model's own package.json + the stable identity from
  // fluidcad.json (null on the first publish → the hub mints one).
  const pkg = readWorkspacePackage(workspace);
  const name = opts.name ?? pkg.name;
  const description = opts.description ?? pkg.description;
  const modelId = readModelId(workspace);

  // Render once to capture the full param schema for the manifest. This also
  // acts as a build gate — a compile/runtime error fails the publish here,
  // before anything is uploaded.
  //
  // Dynamic import is deliberate (and necessary): this pulls in the whole
  // engine — Vite + OC wasm, ~40MB / ~110ms. bin/fluidcad.js eagerly loads
  // every command module at startup, so a top-level import here would make
  // `init`, `serve`, `login`, `--help` etc. pay that cost too. Loading it only
  // when `publish` actually runs is the justified exception to "no inline
  // imports".
  console.log('Building model…');
  const { captureParamDefinitions } = await import(
    '../../server/dist/model-package/capture-params.js'
  );
  let paramDefinitions;
  try {
    paramDefinitions = await captureParamDefinitions(entry, workspace);
  } catch (err) {
    throw new Error(`Model failed to build — fix the error and retry:\n${err?.message ?? err}`);
  }

  // Pack the whole workspace (Pack v2), embedding the captured params. Lazy
  // import for the same reason (keeps esbuild/jszip off the startup path of
  // non-publish commands), consistent with how `pack` loads it.
  const { packModel } = await import('../../server/dist/model-package/pack.js');
  const { manifest, zip } = await packModel({
    entryPath: entry,
    workspacePath: workspace,
    fluidcadVersion: readPackageVersion(),
    name,
    description,
    paramDefinitions,
  });

  // Show exactly what's going up so stray files/secrets get caught before they
  // leave the machine (the .gitignore guard plus an always-exclude list).
  const files = manifest.files ?? [];
  console.log(`\nUploading ${files.length} file${files.length === 1 ? '' : 's'} (${(zip.length / 1024).toFixed(1)} KB):`);
  for (const f of files) {
    console.log(`  ${f}`);
  }

  const form = new FormData();
  form.append('fluidpkg', new Blob([zip], { type: 'application/zip' }), 'model.fluidpkg');
  if (modelId) {
    form.append('modelId', modelId);
  }
  if (name) {
    form.append('name', name);
  }
  if (opts.visibility) {
    form.append('visibility', opts.visibility);
  }

  const { status, body } = await new HubClient(hubUrl, creds.token).postForm('/api/publish', form);
  if (status === 401) {
    throw new Error('Your session has expired. Run `fluidcad login` again.');
  }
  if (status === 403) {
    throw new Error(body.error || 'That model belongs to another account.');
  }
  if (status === 422) {
    throw new Error(body.error || 'That FluidCAD version is not hosted yet.');
  }
  if (status !== 200 && status !== 201) {
    throw new Error(body.error || `Publish failed (HTTP ${status})`);
  }

  // First publish for this workspace → persist the hub-minted id so the next
  // publish lands as a new version of the same model.
  if (!modelId && body.modelId) {
    writeModelId(workspace, body.modelId);
  }

  console.log('');
  if (body.isNewVersion) {
    console.log(`A new version (v${body.version}) will be published — add details in your browser.`);
  } else {
    console.log('Created model — finish setup in your browser.');
  }

  if (body.formUrl) {
    const formUrl = body.formUrl.startsWith('http') ? body.formUrl : hubUrl + body.formUrl;
    console.log(`\n  ${formUrl}\n`);
    await openBrowser(formUrl);
  } else if (body.shareUrl) {
    // Fallback for a pre-v2 hub that deployed synchronously and has no form.
    console.log(`\n  ${body.shareUrl}\n`);
  }
}

export function registerPublishCommand(program) {
  program
    .command('publish')
    .description('Pack the current model and publish it to the FluidCAD hub')
    .option('-w, --workspace <path>', 'Workspace directory (defaults to cwd)')
    .option('-e, --entry <file>', 'Entry .fluid.js file (auto-detected if only one exists)')
    .option('-n, --name <name>', 'Model name (defaults to the package name)')
    .option('-d, --description <text>', 'Optional human description')
    .option('--visibility <visibility>', 'public | unlisted | private (default: unlisted)')
    .option('--hub <url>', 'Hub base URL (default: the hub you logged into)')
    .action((opts) => {
      runPublish(opts)
        // The render spins up engine + Vite handles; exit explicitly so a
        // successful publish doesn't hang waiting for the loop to drain.
        .then(() => process.exit(0))
        .catch((err) => {
          console.error(err?.message ?? err);
          process.exit(1);
        });
    });
}

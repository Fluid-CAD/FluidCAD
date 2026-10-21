import type { FluidCadServer, SceneRenderedData } from '../fluidcad-server/index.ts';

/**
 * A request's `configuration` the file does not declare, or that has no
 * scene to switch; `status` is the HTTP answer and `names` the declared rows.
 */
export class ConfigurationSwitchError extends Error {
  constructor(message: string, readonly status: number, readonly names: string[] = []) {
    super(message);
  }
}

/**
 * Run a UI capture with the named `configurations()` row on screen
 * (`docs/assembly-configurations-plan.md` §3.7). A screenshot is drawn by the
 * connected page, so unlike an export it cannot come from a scratch render:
 * the session is switched to the row and re-rendered, the pages are told,
 * `capture` runs once the viewer shows that render (`awaitApplied`), and then the session is
 * put back — the previous active row and its override map — and re-rendered
 * and broadcast again. The row already on screen captures as is. A name the
 * file does not declare throws a {@link ConfigurationSwitchError} (400) that
 * lists the declared rows; the restore runs whatever the capture did.
 */
export function createConfigurationScreenshot(
  fluidCadServer: Pick<FluidCadServer, 'getCurrentFileName' | 'getConfigurations' | 'getActiveConfiguration' | 'getParamOverrides' | 'selectConfiguration' | 'restoreParamOverrides' | 'recomputeCurrentFile'>,
  broadcastRender: (data: SceneRenderedData) => void,
  awaitApplied: () => Promise<unknown> = async () => {},
): (name: string, capture: () => Promise<Buffer>) => Promise<Buffer> {
  return async (name, capture) => {
    const file = fluidCadServer.getCurrentFileName();
    if (!file) {
      throw new ConfigurationSwitchError('No active scene to capture.', 404);
    }
    const declared = fluidCadServer.getConfigurations(file).names;
    if (name !== 'Default' && !declared.includes(name)) {
      throw new ConfigurationSwitchError(
        declared.length > 0
          ? `Unknown configuration '${name}'. Declared: ${declared.map(n => `'${n}'`).join(', ')} (and Default).`
          : `Unknown configuration '${name}': the file declares no configurations() table (only Default).`,
        400,
        declared,
      );
    }
    const previous = fluidCadServer.getActiveConfiguration(file);
    if (name === previous) {
      return capture();
    }
    const overrides = fluidCadServer.getParamOverrides(file);
    const rerender = async (): Promise<void> => {
      const data = await fluidCadServer.recomputeCurrentFile();
      if (data) {
        broadcastRender(data);
      }
    };
    fluidCadServer.selectConfiguration(file, name);
    try {
      await rerender();
      // The page draws the capture: let it show the row's render first.
      await awaitApplied();
      return await capture();
    } finally {
      fluidCadServer.selectConfiguration(file, previous);
      fluidCadServer.restoreParamOverrides(file, overrides);
      await rerender();
    }
  };
}

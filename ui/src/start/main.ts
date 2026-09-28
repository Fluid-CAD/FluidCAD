import { chooseStartHost } from './choose-host';
import { HttpStartHost } from './http-host';
import { StartScreen } from './start-screen';

/**
 * The start screen's entry. Two launchers render it: the desktop app, which
 * serves it over `fluidcad-app://start/` and exposes `window.fluidcadShell`,
 * and `npx fluidcad`, which serves it over http next to an API. A dev build
 * also accepts `?host=fixture` (see `fixture-host.ts`), so the page can be
 * worked on under `npm run dev:ui`.
 */
async function boot(): Promise<void> {
  const root = document.getElementById('fluidcad-start')!;
  const servedOverHttp = location.protocol === 'http:' || location.protocol === 'https:';
  const host = await chooseStartHost({
    bridge: window.fluidcadShell?.start,
    search: location.search,
    loadFixture: import.meta.env.DEV
      ? async (params) => new (await import('./fixture-host')).FixtureStartHost(params)
      : null,
    loadHttp: servedOverHttp ? () => new HttpStartHost() : null,
  });
  if (!host) {
    const notice = document.createElement('p');
    notice.className = 'h-full grid place-items-center text-sm text-base-content/60';
    notice.textContent = 'Open FluidCAD with npx fluidcad, or from the desktop app.';
    root.replaceChildren(notice);
    return;
  }
  await new StartScreen(root, host).start();
}

void boot();

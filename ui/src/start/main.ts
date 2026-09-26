import { chooseStartHost } from './choose-host';
import { StartScreen } from './start-screen';

/**
 * The start screen's entry. It renders only inside FluidCAD Desktop, which
 * serves it over `fluidcad-app://start/` and exposes `window.fluidcadShell`.
 * A dev build also accepts `?host=fixture` (see `fixture-host.ts`), so the
 * page can be worked on under `npm run dev:ui`.
 */
async function boot(): Promise<void> {
  const root = document.getElementById('fluidcad-start')!;
  const host = await chooseStartHost({
    bridge: window.fluidcadShell?.start,
    search: location.search,
    loadFixture: import.meta.env.DEV
      ? async (params) => new (await import('./fixture-host')).FixtureStartHost(params)
      : null,
  });
  if (!host) {
    const notice = document.createElement('p');
    notice.className = 'h-full grid place-items-center text-sm text-base-content/60';
    notice.textContent = 'The start screen runs inside FluidCAD Desktop.';
    root.replaceChildren(notice);
    return;
  }
  await new StartScreen(root, host).start();
}

void boot();

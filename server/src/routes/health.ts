import { Router } from 'express';
import type { LengthUnit } from '../project-config.ts';

export type HealthInfo = {
  version: string;
  workspacePath: string;
  startedAt: string;
  /**
   * The engine version this project pins (`fluidcad.json`), or null when it
   * pins none. `version` is what's actually running; the two disagreeing is
   * the signal that geometry may have moved under the project. Optional
   * because hub mode serves a packed bundle, which has no workspace to pin.
   */
  enginePin?: string | null;
  /**
   * The project's configured document unit (`fluidcad.json`), or null when
   * it sets none — which means mm. Optional for the same reason as the pin.
   */
  unit?: LengthUnit | null;
  /**
   * Live reader for the project unit. The unit chip rewrites `fluidcad.json`
   * while the server runs, so a startup snapshot would go stale; when given,
   * it wins over `unit`.
   */
  readUnit?: () => LengthUnit | null;
};

export function createHealthRouter(info: HealthInfo): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: info.version,
      workspacePath: info.workspacePath,
      startedAt: info.startedAt,
      enginePin: info.enginePin ?? null,
      unit: (info.readUnit ? info.readUnit() : info.unit) ?? null,
      pid: process.pid,
    });
  });

  return router;
}

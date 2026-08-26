import { Router } from 'express';

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
      pid: process.pid,
    });
  });

  return router;
}

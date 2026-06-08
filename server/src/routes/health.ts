import { Router } from 'express';

export type HealthInfo = {
  version: string;
  workspacePath: string;
  startedAt: string;
};

export function createHealthRouter(info: HealthInfo): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      version: info.version,
      workspacePath: info.workspacePath,
      startedAt: info.startedAt,
      pid: process.pid,
    });
  });

  return router;
}

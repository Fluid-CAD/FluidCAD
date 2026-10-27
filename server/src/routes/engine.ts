import { Router } from 'express';
import type { EngineHealth } from '../engine-health.ts';

export type EngineRouterOptions = {
  /**
   * End this engine with `code` once the answer is on its way — the host
   * that forked it starts a fresh one. Index wires it to its shutdown path.
   */
  exit: (code: number) => void;
  /** How long the answer gets to leave before the process ends. */
  exitDelayMs?: number;
};

/**
 * The engine's own lifecycle, as the page drives it.
 *
 * `POST /engine/restart` ends this engine so its host starts a fresh one on
 * the same port, where the page reconnects by itself — the only way back
 * to a sound heap once the kernel trapped (see {@link EngineHealth}). Only a
 * host that restarts its engine on an exit code (`fluidcad serve`) offers
 * it; anywhere else the answer is 409 with the sentence saying how to
 * restart instead.
 */
export function createEngineRouter(health: EngineHealth, options: EngineRouterOptions): Router {
  const router = Router();

  router.post('/engine/restart', (_req, res) => {
    const exitCode = health.restartExitCode;
    if (exitCode === null) {
      res.status(409).json({ error: `This engine can't restart itself. ${health.restartHint}` });
      return;
    }
    res.json({ restarting: true });
    res.on('finish', () => {
      setTimeout(() => options.exit(exitCode), options.exitDelayMs ?? 50);
    });
  });

  return router;
}

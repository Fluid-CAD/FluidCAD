import { Container, getContainer } from '@cloudflare/containers';

// Env (the bindings and vars) comes from `wrangler types`; the secrets are set with `wrangler secret put`.
type Bindings = Env & { AUTH_USER: string; AUTH_PASS: string };

export class FluidCAD extends Container<Bindings> {
  defaultPort = 3100;
  // The container's disk is ephemeral: projects are lost when it sleeps.
  sleepAfter = '2h';

  constructor(ctx: DurableObjectState<{}>, env: Bindings) {
    super(ctx, env);
    // FluidCAD answers only the host it is reached by, and takes this origin as the page's own.
    this.envVars = { FLUIDCAD_PUBLIC_URL: env.PUBLIC_URL };
  }
}

const encoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(left, right);
}

function authorized(request: Request, env: Bindings): boolean {
  const header = request.headers.get('Authorization') ?? '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    return false;
  }
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return false;
  }
  const at = decoded.indexOf(':');
  if (at === -1) {
    return false;
  }
  // Both compared, whichever fails first, so timing says nothing about which.
  const user = timingSafeEqual(decoded.slice(0, at), env.AUTH_USER);
  const pass = timingSafeEqual(decoded.slice(at + 1), env.AUTH_PASS);
  return user && pass;
}

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    if (!env.AUTH_USER || !env.AUTH_PASS) {
      return new Response('AUTH_USER and AUTH_PASS secrets are not set.', { status: 500 });
    }
    if (!authorized(request, env)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="FluidCAD", charset="UTF-8"' },
      });
    }
    // One instance: every visitor shares the same projects.
    return getContainer(env.FLUIDCAD).fetch(request);
  },
};

import http from 'http';
import { randomBytes, createHash } from 'crypto';
import { getHubUrl, writeCredentials } from '../lib/config.js';
import { HubClient } from '../lib/api-client.js';
import { openBrowser } from '../lib/browser.js';

const CLIENT_ID = 'fluidcad-cli';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function base64url(buf) {
  return buf.toString('base64url');
}

/**
 * Loopback + PKCE login (RFC 8252): spin up a one-shot 127.0.0.1 server, send
 * the browser to the hub's /cli/authorize, receive the code on /callback,
 * exchange it (with the PKCE verifier) for a token, and save it.
 */
function runLogin(opts) {
  return new Promise((resolve, reject) => {
    const hubUrl = getHubUrl(opts.hub);
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));
    let redirectUri;
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close();
      fn(arg);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;text-align:center;padding-top:3rem">' +
          '<h2>FluidCAD CLI</h2><p>You can close this tab and return to your terminal.</p>',
      );
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      (async () => {
        if (error) {
          throw new Error(`authorization ${error}`);
        }
        if (returnedState !== state) {
          throw new Error('state mismatch — aborting (possible CSRF)');
        }
        if (!code) {
          throw new Error('no authorization code in callback');
        }
        const { status, body } = await new HubClient(hubUrl).postJson('/api/cli/token', {
          client_id: CLIENT_ID,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        });
        if (status !== 200 || !body.access_token) {
          throw new Error(`token exchange failed: ${body.error_description || body.error || `HTTP ${status}`}`);
        }
        writeCredentials({ token: body.access_token, email: body.user?.email ?? null, hubUrl });
        return body.user?.email ?? null;
      })().then(
        (email) => finish(resolve, email),
        (err) => finish(reject, err),
      );
    });

    const timer = setTimeout(
      () => finish(reject, new Error('login timed out — no response within 5 minutes')),
      LOGIN_TIMEOUT_MS,
    );

    server.on('error', (err) => finish(reject, err));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const authorizeUrl =
        `${hubUrl}/cli/authorize?` +
        new URLSearchParams({
          response_type: 'code',
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
        });
      console.log('Opening your browser to authorize the FluidCAD CLI…');
      console.log(`\n  ${authorizeUrl}\n`);
      openBrowser(authorizeUrl);
    });
  });
}

export function registerLoginCommand(program) {
  program
    .command('login')
    .description('Authenticate this machine with the FluidCAD hub')
    .option('--hub <url>', 'Hub base URL (default: $FLUIDCAD_HUB_URL or https://hub.fluidcad.io)')
    .action((opts) => {
      runLogin(opts)
        .then((email) => console.log(`Logged in as ${email ?? 'your account'}`))
        .catch((err) => {
          console.error(err?.message ?? err);
          process.exit(1);
        });
    });
}

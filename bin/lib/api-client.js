import { getHubUrl } from './config.js';

/**
 * Tiny client for the hub API. The CLI commands are pure API clients — open a
 * browser, store a token, POST a package — so this just wraps `fetch` with the
 * bearer header and a uniform `{ status, body }` result.
 */
export class HubClient {
  constructor(hubUrl, token) {
    this.base = getHubUrl(hubUrl);
    this.token = token;
  }

  #authHeaders(extra = {}) {
    return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  async #result(res) {
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  async postJson(path, body) {
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers: this.#authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return this.#result(res);
  }

  async postForm(path, form) {
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers: this.#authHeaders(),
      body: form,
    });
    return this.#result(res);
  }
}

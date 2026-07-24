/* ============================================================
 * store.js — remote session store (talks to the Lambda API via API Gateway).
 * Same-origin: the API lives at "<app dir>/api/*" behind CloudFront, so no
 * CORS. Auth is a secret the user pastes once (kept in Settings/localStorage),
 * sent in the X-Api-Key header. Writes send a JSON body.
 * All methods return promises. Exposes window.Store.
 * ============================================================ */
(function (global) {
  'use strict';

  // Default API base = the app's own directory + "api" (no trailing slash).
  // e.g. https://host/treeni/  ->  https://host/treeni/api
  function defaultBase() {
    const dir = global.location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
    return new URL('api', dir).href;
  }

  const S = () => global.Settings; // resolved lazily (app.js defines it)

  const Store = {
    base() { return (S() && S().get('apiBase')) || defaultBase(); },
    token() { return (S() && S().get('apiToken')) || ''; },
    setToken(t) { S().set('apiToken', (t || '').trim()); },
    setBase(b) { S().set('apiBase', (b || '').trim().replace(/\/$/, '')); },
    configured() { return !!this.token(); },

    async _req(method, path, body) {
      const headers = { 'X-Api-Key': this.token() };
      if (body) headers['content-type'] = 'application/json';
      let res;
      try {
        res = await fetch(this.base() + path, {
          method, headers, body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new Error('network error — is the backend deployed and reachable?');
      }
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* ignore */ }
        if (res.status === 401) msg = 'unauthorized — check the API token';
        const err = new Error(msg); err.status = res.status; throw err;
      }
      return res.status === 204 ? null : res.json();
    },

    // Writes send a JSON body (API Gateway handles it — no signing). This
    // carries the workout entries[]; volume/sets/reps are derived server-side.
    async list() { return (await this._req('GET', '/sessions')).sessions; },
    async create(s) { return (await this._req('POST', '/sessions', s)).session; },
    async update(id, s) { return (await this._req('PUT', '/sessions/' + encodeURIComponent(id), s)).session; },
    async remove(id) { return this._req('DELETE', '/sessions/' + encodeURIComponent(id)); },
  };

  global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);

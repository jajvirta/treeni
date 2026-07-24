/* ============================================================
 * app.js — settings, the Sessions store, view routing, keyboard bus.
 * Loaded last; wires the modules together on DOMContentLoaded.
 * localStorage-first; the optional backend (store.js/Store) can mirror
 * Sessions later without changing the views.
 * ============================================================ */
(function (global) {
  'use strict';

  // --- Settings --------------------------------------------------------
  const DEFAULTS = { freqAim: 2, freqFloor: 1, unit: 'kg', lastView: 'today', superset: ['bench-press', 'seated-row'] };
  const SKEY = 'trn.settings';
  let store = {};
  try { store = JSON.parse(global.localStorage.getItem(SKEY)) || {}; } catch (e) { store = {}; }
  const Settings = {
    get(k) { return k in store ? store[k] : DEFAULTS[k]; },
    set(k, v) { store[k] = v; try { global.localStorage.setItem(SKEY, JSON.stringify(store)); } catch (e) { /* ignore */ } },
  };
  global.Settings = Settings;

  // --- Sessions store (DynamoDB via Store; localStorage mirror for reads) ---
  // The backend is the source of truth. We keep a read-only mirror in
  // localStorage so the UI still shows recent data offline; writes go straight
  // to the backend and update the mirror on success.
  const CACHE_KEY = 'trn.cache';
  let cache = [];
  try { cache = JSON.parse(global.localStorage.getItem(CACHE_KEY)) || []; } catch (e) { cache = []; }
  if (!Array.isArray(cache)) cache = [];
  const mirror = () => { try { global.localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ } };
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  const Sessions = {
    configured() { return global.Store && Store.configured(); },
    all() { return cache.slice().sort(byDate); },
    async refresh() {
      if (!this.configured()) return cache;
      const list = await Store.list();
      cache = Array.isArray(list) ? list : [];
      mirror();
      return cache;
    },
    async add(session) { const rec = await Store.create(session); cache.push(rec); mirror(); return rec; },
    async update(id, patch) {
      const rec = await Store.update(id, patch);
      const i = cache.findIndex(s => s.id === id); if (i >= 0) cache[i] = rec; mirror(); return rec;
    },
    async remove(id) { await Store.remove(id); cache = cache.filter(s => s.id !== id); mirror(); },
  };
  global.Sessions = Sessions;

  // Re-render the active view (controllers call this after a write/refresh).
  global.rerender = () => {
    const c = VIEWS[activeView] && VIEWS[activeView].ctrl();
    if (c && c.onActivate) c.onActivate();
  };

  // --- View routing ----------------------------------------------------
  const VIEWS = {
    today: { ctrl: () => global.Workout },
    progress: { ctrl: () => global.Progress },
    program: { ctrl: () => global.Program },
  };
  let activeView = null;

  function switchView(name) {
    if (!VIEWS[name]) name = 'today';
    if (activeView === name) return;
    Object.keys(VIEWS).forEach(key => {
      const v = VIEWS[key];
      const on = key === name;
      v.el.classList.toggle('hidden', !on);
      v.tab.classList.toggle('active', on);
      v.tab.setAttribute('aria-selected', on ? 'true' : 'false');
      const c = v.ctrl();
      if (on && c && c.onActivate) c.onActivate();
      if (!on && c && c.onDeactivate) c.onDeactivate();
    });
    activeView = name;
    Settings.set('lastView', name);
  }
  global.switchView = switchView;

  // --- Boot ------------------------------------------------------------
  function boot() {
    Object.keys(VIEWS).forEach(key => {
      VIEWS[key].el = document.getElementById('view-' + key);
      VIEWS[key].tab = document.querySelector('.tab[data-view="' + key + '"]');
      VIEWS[key].tab.addEventListener('click', () => switchView(key));
    });

    if (global.Catalog) Catalog.seedIfEmpty();
    if (global.Workout) Workout.init();
    if (global.Progress) Progress.init();
    if (global.Program) Program.init();

    // One keyboard bus → active controller. Ignore when typing in form fields.
    global.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const c = VIEWS[activeView] && VIEWS[activeView].ctrl();
      if (c && c.onKey) c.onKey(e);
    });

    switchView(Settings.get('lastView'));
    // Pull sessions from the backend, then re-render; if unconnected, send the
    // user to Program to paste their API token.
    if (Sessions.configured()) {
      Sessions.refresh().then(global.rerender).catch(() => { /* offline: mirror stays */ });
    } else {
      switchView('program');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);

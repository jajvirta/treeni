/* ============================================================
 * app.js — settings, the Sessions store, view routing, keyboard bus.
 * Loaded last; wires the modules together on DOMContentLoaded.
 * localStorage-first; the optional backend (store.js/Store) can mirror
 * Sessions later without changing the views.
 * ============================================================ */
(function (global) {
  'use strict';

  // --- Settings --------------------------------------------------------
  const DEFAULTS = {
    freqAim: 2, freqFloor: 1, unit: 'kg', lastView: 'today', superset: ['bench-press', 'seated-row'],
    // The fat-loss plan (Body view) — config, not data. Three numbers you could
    // retype in half a minute, unlike the daily weigh-ins, so it stays local.
    plan: null,
    // Only self-reported habits — steps are measured, so they're a gauge, not a tap.
    habitKeys: ['protein', 'sleep'],
  };
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

  // --- Day logs (weigh-in / steps / habits / Zone 2) --------------------
  // Same mirror pattern as Sessions, plus an outbox: a write that can't reach
  // the backend stays in the mirror flagged `pending` and is retried on the
  // next refresh. A weigh-in taken on bad wifi is not worth losing — it's one
  // point in a series that needs years of them.
  const DAYS_KEY = 'trn.days';
  let days = [];
  try { days = JSON.parse(global.localStorage.getItem(DAYS_KEY)) || []; } catch (e) { days = []; }
  if (!Array.isArray(days)) days = [];
  const mirrorDays = () => { try { global.localStorage.setItem(DAYS_KEY, JSON.stringify(days)); } catch (e) { /* ignore */ } };

  // Habits are two-state: true, or the key is absent. `false` and "never said"
  // mean the same thing to the analytics, so we don't store the difference.
  function mergeDay(cur, patch) {
    const out = { ...cur, ...patch, date: cur.date };
    if (patch.habits) {
      const h = { ...(cur.habits || {}) };
      Object.keys(patch.habits).forEach(k => { if (patch.habits[k]) h[k] = true; else delete h[k]; });
      out.habits = h;
    }
    if (out.habits && !Object.keys(out.habits).length) delete out.habits;
    ['kg', 'steps', 'notes'].forEach(k => { if (out[k] == null || out[k] === '') delete out[k]; });
    if (Array.isArray(out.cardio) && !out.cardio.length) delete out.cardio;
    delete out.pending;
    return out;
  }
  const dayEmpty = d => d.kg == null && d.steps == null &&
    !(d.cardio || []).length && !Object.keys(d.habits || {}).length;

  const Days = {
    configured() { return global.Store && Store.configured(); },
    all() { return days.slice().sort(byDate); },
    get(date) { return days.find(d => d.date === date) || null; },
    _replace(rec) {
      const i = days.findIndex(d => d.date === rec.date);
      if (i >= 0) days[i] = rec; else days.push(rec);
      mirrorDays();
    },
    async refresh() {
      if (!this.configured()) return days;
      const pending = days.filter(d => d.pending);
      const list = await Store.listLogs();
      days = Array.isArray(list) ? list : [];
      mirrorDays();
      for (const p of pending) {                     // flush the outbox
        const { pending: _p, ...rec } = p;
        try { this._replace(await Store.putLog(rec.date, rec)); }
        catch (e) { this._replace(p); }              // still offline — keep it queued
      }
      return days;
    },
    // Merge a patch into one day and persist it. Returns the stored record.
    async put(date, patch) {
      const next = mergeDay(this.get(date) || { date }, patch || {});
      if (dayEmpty(next)) return this.remove(date);
      if (!this.configured()) { this._replace({ ...next, pending: true }); return next; }
      try { const rec = await Store.putLog(date, next); this._replace(rec); return rec; }
      catch (e) { this._replace({ ...next, pending: true }); throw e; }
    },
    async remove(date) {
      const had = this.get(date);
      days = days.filter(d => d.date !== date);
      mirrorDays();
      if (had && !had.pending && this.configured()) await Store.removeLog(date);
      return null;
    },
  };
  global.Days = Days;

  // Re-render the active view (controllers call this after a write/refresh).
  global.rerender = () => {
    const c = VIEWS[activeView] && VIEWS[activeView].ctrl();
    if (c && c.onActivate) c.onActivate();
  };

  // --- View routing ----------------------------------------------------
  const VIEWS = {
    today: { ctrl: () => global.Workout },
    progress: { ctrl: () => global.Progress },
    body: { ctrl: () => global.Body },
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
    if (global.Body) Body.init();
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
      Promise.allSettled([Sessions.refresh(), Days.refresh()]).then(global.rerender);
    } else {
      switchView('program');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);

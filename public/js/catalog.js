/* ============================================================
 * catalog.js — the exercise catalog (localStorage-backed CRUD) and the
 * default time-efficient full-body program. Seeds on first run.
 * Exposes window.Catalog. Muscle groups are coarse on purpose
 * (legs / push / pull / core) — this is a motivation tool, not sports science.
 * ============================================================ */
(function (global) {
  'use strict';

  const KEY = 'trn.catalog';

  // Default program — minimum effective dose from the "No Time to Lift?" review:
  // ~6 compound machines, 1–2 hard sets each, paired as 3 supersets, 1–2×/week.
  // `targetReps` is the rep count you're aiming for on every set — hit it on all
  // sets (or repeat a session exactly) and the app suggests +`step` kg.
  const DEFAULT_EXERCISES = [
    { id: 'bench-press', name: 'Bench press', muscles: ['push'], machine: true, unit: 'kg', targetReps: 10, step: 2.5 },
    { id: 'seated-row', name: 'Seated row', muscles: ['pull'], machine: true, unit: 'kg', targetReps: 10, step: 2.5 },
    { id: 'leg-press', name: 'Leg press', muscles: ['legs'], machine: true, unit: 'kg', targetReps: 12, step: 5 },
  ];

  // The default superset — bench + row done alternating (agonist–antagonist),
  // the time-saver the review recommends. Editable in the Program tab.
  const DEFAULT_SUPERSET = ['bench-press', 'seated-row'];
  const DEFAULT_PROGRAM = {
    name: 'Time-efficient',
    supersets: [DEFAULT_SUPERSET],
    setsPerExercise: [1, 3],   // hard sets, close to failure
    repRange: [6, 15],
    sessionsPerWeek: [1, 2],   // aim 2, 1 is fine
  };

  let list = [];
  function load() {
    try { list = JSON.parse(global.localStorage.getItem(KEY)) || []; } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
  }
  function persist() {
    try { global.localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  const Catalog = {
    seedIfEmpty() {
      load();
      if (!list.length) { list = DEFAULT_EXERCISES.map(e => ({ ...e })); persist(); }
      return list;
    },
    all() { return list.slice(); },
    get(id) { return list.find(e => e.id === id) || null; },
    add(ex) {
      const id = ex.id || slug(ex.name);
      if (this.get(id)) return this.get(id);
      const rec = {
        id, name: ex.name, muscles: ex.muscles || ['push'], machine: !!ex.machine, unit: ex.unit || 'kg',
        targetReps: ex.targetReps || ex.defaultReps || 10, step: ex.step || 2.5, notes: ex.notes || '',
      };
      list.push(rec); persist(); return rec;
    },
    // Tolerant reads — catalogs seeded before targetReps/step existed fall back.
    target(id) { const e = this.get(id) || {}; return e.targetReps || e.defaultReps || 10; },
    step(id) { const e = this.get(id) || {}; return e.step || 2.5; },
    update(id, patch) {
      const e = this.get(id); if (!e) return null;
      Object.assign(e, patch); persist(); return e;
    },
    remove(id) { list = list.filter(e => e.id !== id); persist(); },
    program() { return DEFAULT_PROGRAM; },
    defaultSuperset() { return DEFAULT_SUPERSET.slice(); },
    defaults() { return DEFAULT_EXERCISES.map(e => ({ ...e })); },
  };

  function slug(name) {
    return String(name || 'exercise').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('ex-' + list.length);
  }

  global.Catalog = Catalog;
})(typeof window !== 'undefined' ? window : globalThis);

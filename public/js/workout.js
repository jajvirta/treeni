/* ============================================================
 * workout.js — the Today view: log an in-progress session.
 *  • Single exercise: tap it, add straight sets (weight × reps).
 *  • Superset: cycles through a group (e.g. bench ↔ row) — after each set it
 *    auto-advances to the next exercise with weight & reps PRE-FILLED from your
 *    last set, so each round is basically one tap.
 * Last time's full sets are shown to beat, plus a live rest clock since your
 * last set on the active machine (each set is stamped with `ts`) and a nudge to
 * add weight once you've matched a session or hit your target reps everywhere.
 * Autosaves to localStorage (trn.current); Finish saves to the backend.
 * Exposes window.Workout { init, onActivate, onDeactivate, onKey }.
 * ============================================================ */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);
  const CUR_KEY = 'trn.current';
  const STALE_REST = 3 * 3600;   // stop showing a live rest clock after 3h
  const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  // 95 → "1:35", 4210 → "1h10"
  const fmtRest = sec => sec >= 3600
    ? `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}`
    : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const fmtSets = (sets, u) => Stats.groupSets(sets).map(g => `${g.weight}${u} × ${g.reps.join(', ')}`).join(' · ');
  const adviceFor = (hist, id) =>
    Stats.progressionAdvice(hist, { targetReps: global.Catalog.target(id), step: global.Catalog.step(id) });

  let els = {};
  let restTimer = null;
  let current = null;      // { date, entries: [{exerciseId, sets:[{weight,reps}]}] }
  let group = null;        // exercise ids being logged (length 1 = single)
  let activeIdx = 0;
  let superMode = false;   // cycle through group, auto-advance on add
  let entry = { weight: '', reps: '' };
  let active = 'weight';
  // Armed whenever a field is (re)focused or pre-filled: the next digit REPLACES
  // the value instead of appending, so you never have to backspace a pre-fill
  // away. '.' is the exception — it extends the value (48 → 48.5).
  let overwrite = false;

  const activeId = () => group && group[activeIdx];

  // ---- persistence ----------------------------------------------------
  function saveCur() { try { global.localStorage.setItem(CUR_KEY, JSON.stringify(current)); } catch (e) { /* ignore */ } }
  function clearCur() { try { global.localStorage.removeItem(CUR_KEY); } catch (e) { /* ignore */ } }
  function loadCur() {
    let c = null;
    try { c = JSON.parse(global.localStorage.getItem(CUR_KEY)); } catch (e) { c = null; }
    current = c && Array.isArray(c.entries) && c.date ? c : { date: todayISO(), entries: [] };
  }
  const hasSets = s => (s.entries || []).some(e => (e.sets || []).length);
  const cleaned = s => ({ date: s.date, entries: (s.entries || []).filter(e => (e.sets || []).length), notes: s.notes || '' });
  function entryFor(exId, create) {
    let e = current.entries.find(x => x.exerciseId === exId);
    if (!e && create) { e = { exerciseId: exId, sets: [] }; current.entries.push(e); }
    return e;
  }
  function supersetGroup() { return (global.Settings.get('superset') || []).filter(id => global.Catalog.get(id)); }

  // ---- home (picker) --------------------------------------------------
  function renderHome() {
    els.date.value = current.date;
    const g = supersetGroup();
    els.superLabel.textContent = g.length >= 2 ? g.map(id => global.Catalog.get(id).name).join('  +  ') : 'Add 2+ exercises to the superset in Program';
    els.superBtn.disabled = g.length < 2;

    const past = global.Sessions.all();
    els.exList.innerHTML = global.Catalog.all().map(ex => {
      const e = entryFor(ex.id, false);
      const doneN = e ? e.sets.length : 0;
      const hist = Stats.exerciseHistory(past, ex.id);
      const last = hist.length ? hist[hist.length - 1] : null;
      const u = ex.unit || 'kg';
      const adv = adviceFor(hist, ex.id);
      const meta = doneN ? `${doneN} set${doneN > 1 ? 's' : ''} today`
        : (last ? `last: ${fmtSets(last.sets, u)}` : 'not logged yet');
      const bump = (!doneN && adv.bump) ? `<div class="ex-bump">⬆ try ${adv.suggestWeight}${u}</div>` : '';
      return `<button class="ex-btn${doneN ? ' done' : ''}" data-ex="${ex.id}">` +
        `<span><span class="tag">${(ex.muscles || [])[0] || ''}</span> ${ex.name}<div class="ex-meta">${meta}</div>${bump}</span>` +
        `<span class="ex-check">${doneN ? '✓' : '›'}</span></button>`;
    }).join('');
    const totalSets = current.entries.reduce((a, e) => a + e.sets.length, 0);
    els.summary.textContent = totalSets
      ? `${totalSets} set${totalSets > 1 ? 's' : ''} logged today — nice. Add more or finish.`
      : 'Any amount counts — showing up is the win.';
    els.finish.disabled = !totalSets;
  }

  function showHome() {
    group = null; superMode = false;
    stopRestTimer();
    document.body.classList.remove('logging');
    els.logger.classList.add('hidden');
    els.home.classList.remove('hidden');
    renderHome();
  }

  // ---- logger ---------------------------------------------------------
  function openSingle(exId) { group = [exId]; superMode = false; activeIdx = 0; openLogger(); }
  function openSuperset() { const g = supersetGroup(); if (g.length < 2) return; group = g; superMode = true; activeIdx = 0; openLogger(); }

  function openLogger() {
    document.body.classList.add('logging');
    els.home.classList.add('hidden');
    els.logger.classList.remove('hidden');
    Numpad.init(els.pad);
    Numpad.setHandlers({ digit: onDigit, backspace: onBackspace, enter: onEnter });
    prefill(activeId());
    renderLogger();
    startRestTimer();
  }

  // ---- rest clock ------------------------------------------------------
  // Ticks once a second while the logger is open, showing how long it's been
  // since your last set ON THIS MACHINE (bench → next bench). Text only — never
  // a full re-render.
  function lastSetTs(id) {
    const e = entryFor(id, false);
    if (!e || !e.sets.length) return null;
    const t = e.sets[e.sets.length - 1].ts;
    return Number.isFinite(t) ? t : null;
  }
  function tickRest() {
    if (!els.rest) return;
    const t = group ? lastSetTs(activeId()) : null;
    const sec = t == null ? null : Math.max(0, Math.round((Date.now() - t) / 1000));
    // A session left open overnight shouldn't claim you've rested 14 hours.
    const show = sec != null && sec <= STALE_REST;
    els.rest.textContent = show ? `⏱ resting ${fmtRest(sec)} since your last set` : '';
    els.rest.classList.toggle('hidden', !show);
  }
  function startRestTimer() { stopRestTimer(); tickRest(); restTimer = global.setInterval(tickRest, 1000); }
  function stopRestTimer() { if (restTimer) { global.clearInterval(restTimer); restTimer = null; } }

  // Pre-fill weight & reps for an exercise: this session's last set if any,
  // else last time's top set — so repeated rounds are one tap.
  function prefill(id) {
    const e = entryFor(id, false);
    if (e && e.sets.length) { const s = e.sets[e.sets.length - 1]; entry = { weight: String(s.weight), reps: String(s.reps) }; }
    else {
      const h = Stats.exerciseHistory(global.Sessions.all(), id);
      const last = h.length ? h[h.length - 1] : null;
      entry = last ? { weight: String(last.topWeight), reps: String(last.topReps) } : { weight: '', reps: '' };
    }
    active = 'weight';
    overwrite = true;
  }

  function renderLogger() {
    const ex = global.Catalog.get(activeId()) || { unit: 'kg', name: activeId() };
    const u = ex.unit || 'kg';
    els.name.textContent = ex.name;

    if (group.length > 1) {
      els.group.classList.remove('hidden');
      els.group.innerHTML = group.map((id, i) => {
        const g = global.Catalog.get(id); const e = entryFor(id, false); const n = e ? e.sets.length : 0;
        return `<button class="ss-chip${i === activeIdx ? ' active' : ''}" data-i="${i}">${g ? g.name : id}<span class="ss-n">${n}</span></button>`;
      }).join('');
      const minSets = Math.min(...group.map(id => { const e = entryFor(id, false); return e ? e.sets.length : 0; }));
      els.round.textContent = `Round ${minSets + 1}`;
      els.round.classList.remove('hidden');
    } else { els.group.classList.add('hidden'); els.round.classList.add('hidden'); }

    const hist = Stats.exerciseHistory(global.Sessions.all(), activeId());
    const last = hist.length ? hist[hist.length - 1] : null;
    els.last.innerHTML = last
      ? `Last time (${last.date}): <b>${fmtSets(last.sets, u)}</b>` +
        (last.avgRest != null ? ` <span class="lt-rest">· rest ~${fmtRest(last.avgRest)}</span>` : '')
      : 'First time logging this — set the bar.';

    const adv = adviceFor(hist, activeId());
    els.advice.textContent = adv.bump
      ? (adv.reason === 'repeat'
        ? `⬆ Same sets two sessions running — try ${adv.suggestWeight}${u} × ${adv.targetReps} today.`
        : `⬆ You hit ${adv.targetReps} reps on every set — try ${adv.suggestWeight}${u} today.`)
      : '';
    els.advice.classList.toggle('hidden', !adv.bump);

    const e = entryFor(activeId(), false);
    const sets = e ? e.sets : [];
    const rests = Stats.restBetween(sets);
    els.sets.innerHTML = sets.map((s, i) =>
      `<li class="set-row"><span class="s-i">${i + 1}</span><span>${s.weight}${u}</span>` +
      `<span>${s.reps} reps</span><span class="s-r">${rests[i] != null ? fmtRest(rests[i]) : ''}</span>` +
      `<button class="s-x" data-i="${i}" aria-label="delete">✕</button></li>`).join('');

    els.weight.textContent = entry.weight === '' ? '—' : entry.weight;
    els.reps.textContent = entry.reps === '' ? '—' : entry.reps;
    els.efWeight.classList.toggle('active', active === 'weight');
    els.efReps.classList.toggle('active', active === 'reps');

    let win = '';
    if (sets.length && last) {
      const cur = Stats.point({ date: current.date, entries: [{ exerciseId: activeId(), sets }] }, activeId());
      const w = Stats.smallWin(last, cur);
      if (w.dw > 0) win = `💪 +${w.dw}${u} on your top set vs last time!`;
      else if (w.dw === 0 && w.dr > 0) win = `💪 +${w.dr} rep${w.dr > 1 ? 's' : ''} on your top set!`;
      else if (w.dv > 0) win = `📈 +${w.dv} volume vs last time.`;
      else if (w.matched) win = `✅ Matched last time — consistency.`;
    } else if (sets.length && !last) win = `✅ Logged — the baseline to beat next time.`;
    els.win.textContent = win;

    const valid = entry.reps !== '' && Number(entry.reps) > 0;
    els.addSet.disabled = !valid;
    els.addSet.textContent = superMode ? 'Log & next →' : 'Add set';
    Numpad.setEnter(active === 'weight' ? 'Next' : (superMode ? 'Next ex' : 'Add'), active === 'weight' ? entry.weight !== '' : valid);
    Numpad.setEnabled('.', active === 'weight' && entry.weight.indexOf('.') < 0);
    tickRest();   // switching exercises re-points the rest clock
  }

  // ---- input ----------------------------------------------------------
  const MAXLEN = { weight: 6, reps: 3 };   // weight fits "1000.5"

  function onDigit(d) {
    if (d === '.' || d === ',') return onDot();
    let v = overwrite ? '' : entry[active];
    overwrite = false;
    v = (v === '0') ? d : (v + d);
    if (v.length > MAXLEN[active]) return;
    entry[active] = v; renderLogger();
  }
  // Fractional plates: 68.5kg. Reps stay whole numbers.
  function onDot() {
    if (active !== 'weight') return;
    overwrite = false;
    const v = entry.weight;
    if (v.indexOf('.') >= 0 || v.length >= MAXLEN.weight) return;
    entry.weight = (v === '' ? '0' : v) + '.';
    renderLogger();
  }
  function onBackspace() {
    overwrite = false;
    if (entry[active]) entry[active] = entry[active].slice(0, -1);
    else if (active === 'reps') { active = 'weight'; overwrite = true; }
    renderLogger();
  }
  function onEnter() {
    if (active === 'weight') { if (entry.weight !== '') setActive('reps'); return; }
    addSet();
  }
  function setActive(f) { active = f; overwrite = true; renderLogger(); }

  function advance() { activeIdx = (activeIdx + 1) % group.length; prefill(activeId()); }

  function addSet() {
    const id = activeId(); const reps = Number(entry.reps);
    if (!(reps > 0)) return;
    const w = Number(entry.weight);   // "68." parses to 68; empty/garbage → 0
    const weight = Number.isFinite(w) ? w : 0;
    entryFor(id, true).sets.push({ weight, reps, ts: Date.now() });
    saveCur();
    if (superMode) advance(); else { entry.reps = ''; active = 'reps'; overwrite = true; }
    renderLogger();
  }
  function repeatLast() {
    const id = activeId(); const e = entryFor(id, false); let src = null;
    if (e && e.sets.length) src = e.sets[e.sets.length - 1];
    else { const h = Stats.exerciseHistory(global.Sessions.all(), id); if (h.length) src = h[h.length - 1].topSet; }
    if (!src) return;
    // stamp now — never inherit src's ts (it may come from a past session)
    entryFor(id, true).sets.push({ weight: src.weight, reps: src.reps, ts: Date.now() });
    saveCur();
    if (superMode) advance(); else { entry = { weight: String(src.weight), reps: '' }; active = 'reps'; overwrite = true; }
    renderLogger();
  }
  function deleteSet(i) {
    const e = entryFor(activeId(), false); if (!e) return;
    e.sets.splice(i, 1);
    if (!e.sets.length) current.entries = current.entries.filter(x => x !== e);
    saveCur(); renderLogger();
  }

  // ---- finish (save to the backend) -----------------------------------
  async function finish() {
    if (!hasSets(current)) return;
    if (!global.Sessions.configured()) { setStatus('Connect to the backend in the Program tab first.', 'err'); return; }
    els.finish.disabled = true; setStatus('Saving…');
    try {
      await global.Sessions.add(cleaned(current));
      clearCur(); current = { date: todayISO(), entries: [] };
      showHome();
      setStatus('Session saved 💪 — see it on Progress.', 'ok');
    } catch (e) {
      setStatus((e && e.message) || 'save failed — your entry is kept, try again', 'err');
      els.finish.disabled = false;
    }
  }
  function changeDate(v) { if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { current.date = v; saveCur(); renderHome(); } }
  function setStatus(msg, kind) { els.status.textContent = msg || ''; els.status.className = 'log-status' + (kind ? ' ' + kind : ''); }

  function onKey(e) {
    if (!group) return;
    if (e.key >= '0' && e.key <= '9') { onDigit(e.key); e.preventDefault(); }
    else if (e.key === '.' || e.key === ',') { onDot(); e.preventDefault(); }
    else if (e.key === 'Backspace') { onBackspace(); e.preventDefault(); }
    else if (e.key === 'Enter') { onEnter(); e.preventDefault(); }
  }

  global.Workout = {
    init() {
      els = {
        home: $('todayHome'), logger: $('exLogger'),
        date: $('sessionDate'), summary: $('todaySummary'), exList: $('exList'),
        superBtn: $('btnSuperset'), superLabel: $('supersetLabel'),
        finish: $('btnFinish'), status: $('todayStatus'),
        name: $('elName'), group: $('elGroup'), round: $('elRound'), last: $('elLast'),
        rest: $('elRest'), advice: $('elAdvice'), sets: $('elSets'),
        efWeight: $('efWeight'), efReps: $('efReps'), weight: $('elWeight'), reps: $('elReps'),
        win: $('elWin'), pad: $('loggerPad'), addSet: $('btnAddSet'), repeat: $('btnRepeat'), back: $('elBack'),
      };
      loadCur();
      els.exList.addEventListener('click', e => { const b = e.target.closest('[data-ex]'); if (b) openSingle(b.getAttribute('data-ex')); });
      els.superBtn.addEventListener('click', openSuperset);
      els.finish.addEventListener('click', finish);
      els.date.addEventListener('change', e => changeDate(e.target.value));
      els.back.addEventListener('click', showHome);
      els.addSet.addEventListener('click', addSet);
      els.repeat.addEventListener('click', repeatLast);
      els.sets.addEventListener('click', e => { const x = e.target.closest('.s-x'); if (x) deleteSet(parseInt(x.getAttribute('data-i'), 10)); });
      els.group.addEventListener('click', e => { const ch = e.target.closest('.ss-chip'); if (ch) { activeIdx = parseInt(ch.getAttribute('data-i'), 10); prefill(activeId()); renderLogger(); } });
      els.efWeight.addEventListener('click', () => setActive('weight'));
      els.efReps.addEventListener('click', () => setActive('reps'));
    },
    onActivate() { loadCur(); if (group) { renderLogger(); startRestTimer(); } else showHome(); setStatus(''); },
    onDeactivate() { stopRestTimer(); if (group) showHome(); },
    onKey,
  };
})(typeof window !== 'undefined' ? window : globalThis);

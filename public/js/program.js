/* ============================================================
 * program.js — the Program view: backend connection (paste API token),
 * the default time-efficient superset program, and the exercise catalog
 * editor. Exposes window.Program { init, onActivate, onDeactivate, onKey }.
 * ============================================================ */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const GROUPS = ['legs', 'push', 'pull', 'core'];

  let els = {};

  function connectHtml() {
    const connected = global.Sessions.configured();
    const token = (global.Settings.get('apiToken') || '');
    const base = (global.Settings.get('apiBase') || '');
    return '<div class="connect">' +
      '<h2>Backend connection</h2>' +
      `<p class="hint-text">Workouts are stored in DynamoDB. Paste your API token once — it's kept only in this browser (sent in the <code>X-Api-Key</code> header). See <code>infra/BACKEND.md</code>.</p>` +
      `<input type="password" id="apiToken" autocomplete="off" placeholder="API token" value="${esc(token)}">` +
      `<input type="text" id="apiBase" autocomplete="off" placeholder="API base (optional — defaults to ./api)" value="${esc(base)}">` +
      '<button class="btn-primary" id="btnConnect">Save &amp; connect</button>' +
      `<div id="connStatus" class="conn-status ${connected ? 'ok' : ''}">${connected ? 'Connected ✓' : 'Not connected — paste your token to sync.'}</div>` +
      '</div>';
  }

  function supersetHtml() {
    const sel = new Set(global.Settings.get('superset') || []);
    const rows = global.Catalog.all().map(e =>
      `<label class="field checkbox ss-opt"><input type="checkbox" data-id="${esc(e.id)}"${sel.has(e.id) ? ' checked' : ''}> ${esc(e.name)}</label>`).join('');
    return '<div class="setup-card"><h2>Superset</h2>' +
      '<p class="hint-text">Exercises you alternate through — one set each per round. On <b>Today</b>, “Start superset” cycles them with weight &amp; reps pre-filled. 1–2×/week, close to failure.</p>' +
      rows + '<div id="ssHint" class="hint-text"></div></div>';
  }

  function catalogHtml() {
    const rows = global.Catalog.all().map(e =>
      `<div class="cat-row"><span class="c-name">${esc(e.name)} <span class="tag">${(e.muscles || [])[0] || ''}</span></span>` +
      `<button class="c-x" data-id="${esc(e.id)}" aria-label="remove">✕</button></div>`).join('');
    const opts = GROUPS.map(g => `<option value="${g}">${g}</option>`).join('');
    return '<div class="setup-card"><h2>Exercises</h2>' + (rows || '<p class="hint-text">No exercises.</p>') +
      '<div class="cat-add">' +
      '<input type="text" id="newExName" placeholder="New exercise name">' +
      `<select id="newExGroup">${opts}</select>` +
      '<button class="btn-ghost" id="btnAddEx">Add</button></div>' +
      '<button class="btn-ghost" id="btnRestoreDefaults" style="margin-top:8px">Restore default exercises</button>' +
      '</div>';
  }

  function saveSuperset() {
    const ids = Array.from(els.body.querySelectorAll('.ss-opt input:checked')).map(cb => cb.getAttribute('data-id'));
    global.Settings.set('superset', ids);
    const hint = $('ssHint');
    if (hint) hint.textContent = ids.length < 2 ? '⚠ pick at least 2 to use Start superset' : '';
  }

  function render() {
    els.body.innerHTML = connectHtml() + supersetHtml() + catalogHtml();
    $('btnConnect').addEventListener('click', connect);
    $('btnAddEx').addEventListener('click', addExercise);
    $('btnRestoreDefaults').addEventListener('click', restoreDefaults);
    els.body.querySelectorAll('.ss-opt input').forEach(cb => cb.addEventListener('change', saveSuperset));
    els.body.querySelectorAll('.c-x').forEach(b =>
      b.addEventListener('click', () => { global.Catalog.remove(b.getAttribute('data-id')); render(); }));
    saveSuperset();
  }

  async function connect() {
    global.Settings.set('apiToken', ($('apiToken').value || '').trim());
    global.Settings.set('apiBase', ($('apiBase').value || '').trim());
    const status = $('connStatus');
    if (!global.Sessions.configured()) { status.textContent = 'Enter a token to connect.'; status.className = 'conn-status err'; return; }
    status.textContent = 'Connecting…'; status.className = 'conn-status';
    try {
      const list = await global.Sessions.refresh();
      status.textContent = `Connected ✓ — ${list.length} session${list.length === 1 ? '' : 's'} synced.`;
      status.className = 'conn-status ok';
    } catch (e) {
      status.textContent = (e && e.message) || 'connection failed';
      status.className = 'conn-status err';
    }
  }

  function addExercise() {
    const name = ($('newExName').value || '').trim();
    if (!name) return;
    global.Catalog.add({ name, muscles: [$('newExGroup').value], machine: true });
    render();
  }
  function restoreDefaults() {
    global.Catalog.defaults().forEach(d => { if (!global.Catalog.get(d.id)) global.Catalog.add(d); });
    render();
  }

  global.Program = {
    init() { els = { body: $('programBody') }; },
    onActivate() { render(); },
    onDeactivate() {},
    onKey() {},
  };
})(typeof window !== 'undefined' ? window : globalThis);

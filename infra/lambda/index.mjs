/* ============================================================
 * treeni-api — thin CRUD over DynamoDB for one user's workouts.
 * Node 20 Lambda behind a public API Gateway HTTP API (see infra/backend.sh
 * and infra/BACKEND.md). No bundled deps: AWS SDK v3 from the runtime, imported
 * dynamically so the pure helpers below stay unit-testable without the SDK.
 *
 * Storage is intentionally thin — all analytics live client-side in stats.js.
 * A workout session is:
 *   { date:'yyyy-mm-dd', entries:[{ exerciseId, sets:[{weight,reps,ts?}] }], notes? }
 * `ts` is the epoch-ms stamp of when the set was logged — kept so the client can
 * derive rest times between sets; optional (manual/legacy entries have none).
 * darts/score-style totals (volume/sets/reps) are DERIVED here for convenience.
 *
 * A second, independent record type lives in its own partition: the Body view's
 * day log, keyed by date so a write is an idempotent upsert —
 *   { date:'yyyy-mm-dd', kg?, steps?, cardio?:[{min,avgHr?,kind}], habits?, notes? }
 * Nothing is derived from it here; bodystats.js owns the trend/rate maths.
 *
 * Env: TABLE_NAME, API_TOKEN (X-Api-Key), ORIGIN_SECRET (X-Origin-Secret guard).
 * ============================================================ */

const PK = 'me';         // workout sessions
const PK_LOG = 'log';    // day logs (weigh-in / steps / habits / Zone 2)
const EX_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HABIT_KEYS = ['protein', 'steps', 'sleep', 'alcohol', 'veg'];

export function json(status, body) {
  return { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export function header(headers, name) {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k];
  return undefined;
}

// Returns null when authorized, or a {statusCode,...} response when not.
export function checkAuth(headers, env) {
  if (env.ORIGIN_SECRET && header(headers, 'x-origin-secret') !== env.ORIGIN_SECRET) {
    return json(403, { error: 'forbidden' });
  }
  const token = header(headers, 'x-api-key') || '';
  if (!env.API_TOKEN || token !== env.API_TOKEN) return json(401, { error: 'unauthorized' });
  return null;
}

// Validate + normalize an incoming workout session. {ok,value}|{ok:false,error}.
export function validateSession(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'body must be an object' };
  const date = String(obj.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'date must be yyyy-mm-dd' };
  const notes = obj.notes == null ? '' : String(obj.notes).slice(0, 500);

  let entriesRaw = obj.entries;
  if (typeof entriesRaw === 'string') { try { entriesRaw = JSON.parse(entriesRaw); } catch (e) { return { ok: false, error: 'entries must be JSON' }; } }
  if (!Array.isArray(entriesRaw)) return { ok: false, error: 'entries must be an array' };
  if (entriesRaw.length > 60) return { ok: false, error: 'too many entries (max 60)' };

  const entries = [];
  let volume = 0, setCount = 0, repTotal = 0;
  for (const e of entriesRaw) {
    if (!e || typeof e !== 'object') return { ok: false, error: 'each entry must be an object' };
    const exerciseId = String(e.exerciseId || '');
    if (!EX_ID.test(exerciseId)) return { ok: false, error: 'exerciseId must match [a-z0-9-] (1–64)' };
    if (!Array.isArray(e.sets)) return { ok: false, error: 'entry.sets must be an array' };
    if (e.sets.length > 60) return { ok: false, error: 'too many sets in one exercise (max 60)' };
    const sets = [];
    for (const s of e.sets) {
      const weight = Number(s && s.weight);
      const reps = Number(s && s.reps);
      if (!Number.isFinite(weight) || weight < 0 || weight > 2000) return { ok: false, error: 'weight must be 0–2000' };
      if (!Number.isInteger(reps) || reps < 1 || reps > 1000) return { ok: false, error: 'reps must be an integer 1–1000' };
      const set = { weight, reps };
      if (s && s.ts != null) {
        const ts = Number(s.ts);
        // epoch ms, loosely sane: 2001-09-09 … 2096. Bad stamps are rejected
        // rather than dropped, so a client bug surfaces instead of silently
        // losing rest data.
        if (!Number.isInteger(ts) || ts < 1e12 || ts > 4e12) return { ok: false, error: 'set.ts must be an epoch-ms integer' };
        set.ts = ts;
      }
      sets.push(set);
      volume += weight * reps; setCount += 1; repTotal += reps;
    }
    if (sets.length) entries.push({ exerciseId, sets });
  }
  if (!setCount) return { ok: false, error: 'a session needs at least one set' };

  return { ok: true, value: { date, entries, notes, volume, sets: setCount, reps: repTotal } };
}

// Validate + normalize one day log (the Body view's check-in). Keyed by date,
// so a write is an upsert — no derived totals, the client's bodystats.js owns
// all of that maths. {ok,value}|{ok:false,error}.
export function validateDayLog(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'body must be an object' };
  const date = String(obj.date || '');
  if (!DATE_RE.test(date)) return { ok: false, error: 'date must be yyyy-mm-dd' };
  const value = { date };

  if (obj.kg != null && obj.kg !== '') {
    const kg = Number(obj.kg);
    if (!Number.isFinite(kg) || kg < 30 || kg > 400) return { ok: false, error: 'kg must be 30–400' };
    value.kg = Math.round(kg * 100) / 100;
  }
  if (obj.steps != null && obj.steps !== '') {
    const steps = Number(obj.steps);
    if (!Number.isInteger(steps) || steps < 0 || steps > 100000) return { ok: false, error: 'steps must be an integer 0–100000' };
    value.steps = steps;
  }
  if (obj.cardio != null) {
    if (!Array.isArray(obj.cardio)) return { ok: false, error: 'cardio must be an array' };
    if (obj.cardio.length > 5) return { ok: false, error: 'too many cardio entries (max 5)' };
    const cardio = [];
    for (const c of obj.cardio) {
      if (!c || typeof c !== 'object') return { ok: false, error: 'each cardio entry must be an object' };
      const min = Number(c.min);
      if (!Number.isInteger(min) || min < 1 || min > 600) return { ok: false, error: 'cardio.min must be an integer 1–600' };
      const out = { min, kind: c.kind === 'other' ? 'other' : 'zone2' };
      if (c.avgHr != null && c.avgHr !== '') {
        const hr = Number(c.avgHr);
        if (!Number.isInteger(hr) || hr < 40 || hr > 220) return { ok: false, error: 'cardio.avgHr must be an integer 40–220' };
        out.avgHr = hr;
      }
      cardio.push(out);
    }
    if (cardio.length) value.cardio = cardio;
  }
  if (obj.habits != null) {
    if (typeof obj.habits !== 'object') return { ok: false, error: 'habits must be an object' };
    const habits = {};
    for (const k of Object.keys(obj.habits)) {
      if (!HABIT_KEYS.includes(k)) return { ok: false, error: `unknown habit "${k}"` };
      if (obj.habits[k] === true) habits[k] = true;   // false ≡ absent, by design
    }
    if (Object.keys(habits).length) value.habits = habits;
  }
  if (obj.notes != null) {
    const notes = String(obj.notes).slice(0, 500);
    if (notes) value.notes = notes;
  }

  // An entirely empty day is a delete, not a write — the client removes the
  // record instead, so reaching here means something is confused.
  if (Object.keys(value).length < 2) return { ok: false, error: 'a day log needs at least one of kg/steps/cardio/habits/notes' };
  return { ok: true, value };
}

export function parseRoute(method, pathTail) {
  const parts = pathTail.replace(/^\/+|\/+$/g, '').split('/');
  if (method === 'OPTIONS') return { kind: 'options' };

  if (parts[0] === 'logs') {
    const date = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (date && !DATE_RE.test(date)) return { kind: 'notfound' };
    if (method === 'GET' && !date) return { kind: 'log-list' };
    if (method === 'PUT' && date) return { kind: 'log-put', date };
    if (method === 'DELETE' && date) return { kind: 'log-delete', date };
    return { kind: 'notfound' };
  }

  if (parts[0] !== 'sessions') return { kind: 'notfound' };
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  if (method === 'GET' && !id) return { kind: 'list' };
  if (method === 'POST' && !id) return { kind: 'create' };
  if (method === 'PUT' && id) return { kind: 'update', id };
  if (method === 'DELETE' && id) return { kind: 'delete', id };
  return { kind: 'notfound' };
}

function makeId(date) {
  return `${date}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

let _doc;
async function doc() {
  if (_doc) return _doc;
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  _doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _doc;
}

export async function handler(event) {
  const env = process.env;
  const method = event?.requestContext?.http?.method || 'GET';
  const rawPath = event?.rawPath || '/';
  const tail = rawPath.includes('/api') ? rawPath.slice(rawPath.lastIndexOf('/api') + 4) : rawPath;

  const route = parseRoute(method, tail);
  if (route.kind === 'options') return { statusCode: 204, headers: {} };
  if (route.kind === 'notfound') return json(404, { error: 'not found' });

  const denied = checkAuth(event?.headers, env);
  if (denied) return denied;

  const TABLE = env.TABLE_NAME;
  const d = await doc();
  const { QueryCommand, PutCommand, DeleteCommand, GetCommand } = await import('@aws-sdk/lib-dynamodb');

  try {
    if (route.kind === 'list') {
      const out = await d.send(new QueryCommand({
        TableName: TABLE, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': PK },
      }));
      const items = (out.Items || []).map(stripKeys).sort(byDate);
      return json(200, { sessions: items });
    }
    if (route.kind === 'create') {
      const v = validateSession(parseBody(event));
      if (!v.ok) return json(400, { error: v.error });
      const id = makeId(v.value.date);
      const item = { pk: PK, sk: id, id, createdAt: new Date().toISOString(), ...v.value };
      await d.send(new PutCommand({ TableName: TABLE, Item: item }));
      return json(201, { session: stripKeys(item) });
    }
    if (route.kind === 'update') {
      const existing = await d.send(new GetCommand({ TableName: TABLE, Key: { pk: PK, sk: route.id } }));
      if (!existing.Item) return json(404, { error: 'not found' });
      const v = validateSession(parseBody(event));
      if (!v.ok) return json(400, { error: v.error });
      const item = { ...existing.Item, ...v.value, pk: PK, sk: route.id, id: route.id };
      await d.send(new PutCommand({ TableName: TABLE, Item: item }));
      return json(200, { session: stripKeys(item) });
    }
    if (route.kind === 'delete') {
      await d.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, sk: route.id } }));
      return json(200, { deleted: route.id });
    }

    // --- day logs: own partition, so the session queries above never see them
    if (route.kind === 'log-list') {
      const out = await d.send(new QueryCommand({
        TableName: TABLE, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': PK_LOG },
      }));
      const items = (out.Items || []).map(stripKeys).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return json(200, { logs: items });
    }
    if (route.kind === 'log-put') {
      const body = parseBody(event) || {};
      const v = validateDayLog({ ...body, date: route.date });   // the path wins
      if (!v.ok) return json(400, { error: v.error });
      const item = { pk: PK_LOG, sk: route.date, updatedAt: new Date().toISOString(), ...v.value };
      await d.send(new PutCommand({ TableName: TABLE, Item: item }));
      return json(200, { log: stripKeys(item) });
    }
    if (route.kind === 'log-delete') {
      await d.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK_LOG, sk: route.date } }));
      return json(200, { deleted: route.date });
    }
  } catch (err) {
    console.error('handler error', err);
    return json(500, { error: 'internal error' });
  }
  return json(404, { error: 'not found' });
}

function parseBody(event) {
  if (!event || event.body == null) return null;
  let body = event.body;
  if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
  try { return JSON.parse(body); } catch (e) { return null; }
}
function stripKeys(item) { const { pk, sk, ...rest } = item; return rest; }
function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt < b.createdAt ? -1 : 1); }

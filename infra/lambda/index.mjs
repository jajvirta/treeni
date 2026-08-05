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
 * Env: TABLE_NAME, API_TOKEN (X-Api-Key), ORIGIN_SECRET (X-Origin-Secret guard).
 * ============================================================ */

const PK = 'me';
const EX_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

export function parseRoute(method, pathTail) {
  const parts = pathTail.replace(/^\/+|\/+$/g, '').split('/');
  if (parts[0] !== 'sessions') return { kind: 'notfound' };
  const id = parts[1] ? decodeURIComponent(parts[1]) : null;
  if (method === 'GET' && !id) return { kind: 'list' };
  if (method === 'POST' && !id) return { kind: 'create' };
  if (method === 'PUT' && id) return { kind: 'update', id };
  if (method === 'DELETE' && id) return { kind: 'delete', id };
  if (method === 'OPTIONS') return { kind: 'options' };
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

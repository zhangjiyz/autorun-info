import type { D1Binding, Env, Share } from './types.ts';
import {
  ApiError,
  PROVIDERS,
  isLocal,
  parsePage,
  readMutation,
  submissionEnabled,
  validateShare,
} from './validation.ts';

const PAGE_SIZE = 20;
const SHARE_COLUMNS = `id, game_id AS gameId, url, provider, code, version, nickname, note,
  created_at AS createdAt, report_count AS reportCount`;

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return json({ error: '此接口不支持该请求方法。' }, 405, { Allow: allow });
}

function database(env: Env): D1Binding {
  if (!env.DB) throw new ApiError(503, '社区分享尚未配置完成，请稍后再试。');
  return env.DB;
}

async function hmac(value: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function rateLimit(
  db: D1Binding,
  digest: string,
  action: 'share' | 'report',
  now: number,
): Promise<void> {
  const limits =
    action === 'share'
      ? [
          { seconds: 3600, count: 6 },
          { seconds: 86400, count: 20 },
        ]
      : [
          { seconds: 3600, count: 20 },
          { seconds: 86400, count: 50 },
        ];
  for (const limit of limits) {
    const window = Math.floor(now / limit.seconds);
    const key = `${action}:${limit.seconds}:${window}:${digest}`;
    const result = await db
      .prepare(
        `
      INSERT INTO rate_limits (key, hits, expires_at) VALUES (?, 1, ?)
      ON CONFLICT (key) DO UPDATE SET hits = hits + 1 WHERE hits < ?
      RETURNING hits
    `,
      )
      .bind(key, (window + 1) * limit.seconds, limit.count)
      .first<{ hits: number }>();
    if (!result) throw new ApiError(429, '提交过于频繁，请稍后再试。');
  }
}

async function protectMutation(request: Request, env: Env, action: 'share' | 'report') {
  const url = new URL(request.url);
  if (!submissionEnabled(url, env)) throw new ApiError(503, '社区投稿尚未开放，请稍后再试。');
  const ip = isLocal(url, env) ? '127.0.0.1' : request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 64) throw new ApiError(503, '暂时无法提交，请稍后再试。');
  const db = database(env);
  const now = Math.floor(Date.now() / 1000);
  const digest = await hmac(`rate:${Math.floor(now / 86400)}:${ip}`, env.RATE_LIMIT_SALT!);
  await rateLimit(db, digest, action, now);
  return { db, now, ip };
}

async function cleanupExpired(db: D1Binding, now: number): Promise<void> {
  // Indexed and bounded cleanup avoids a scheduled Worker and unbounded table scans.
  // Feedback totals remain; only the 30-day duplicate-prevention digests expire.
  await db.batch([
    db
      .prepare(
        `DELETE FROM rate_limits WHERE key IN (
      SELECT key FROM rate_limits WHERE expires_at <= ? LIMIT 100
    )`,
      )
      .bind(now),
    db
      .prepare(
        `DELETE FROM share_reports WHERE rowid IN (
      SELECT rowid FROM share_reports WHERE expires_at <= ? LIMIT 100
    )`,
      )
      .bind(now),
  ]);
}

async function createShare(request: Request, env: Env, gameId: string): Promise<Response> {
  const body = await readMutation(request);
  const values = validateShare(body);
  const { db, now } = await protectMutation(request, env, 'share');
  const share: Share = {
    id: crypto.randomUUID(),
    gameId,
    ...values,
    createdAt: new Date(now * 1000).toISOString(),
    reportCount: 0,
  };
  const inserted = await db
    .prepare(
      `
    INSERT INTO shares (id, game_id, url, provider, code, version, nickname, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (game_id, url) DO NOTHING
  `,
    )
    .bind(
      share.id,
      share.gameId,
      share.url,
      share.provider,
      share.code,
      share.version,
      share.nickname,
      share.note,
      share.createdAt,
    )
    .run();
  if (!inserted.meta.changes) throw new ApiError(409, '这个游戏已经收录了相同的网盘链接。');
  // A cleanup outage must not turn a successfully persisted submission into an error.
  try {
    await cleanupExpired(db, now);
  } catch {
    console.error('Share API expiration cleanup failed.');
  }
  return json({ share }, 201);
}

async function reportShare(request: Request, env: Env, id: string): Promise<Response> {
  await readMutation(request);
  const db = database(env);
  const existing = await db
    .prepare('SELECT id FROM shares WHERE id = ?')
    .bind(id)
    .first<{ id: string }>();
  if (!existing) throw new ApiError(404, '没有找到这条分享。');
  const { now, ip } = await protectMutation(request, env, 'report');
  const reporterHash = await hmac(`report:${id}:${ip}`, env.RATE_LIMIT_SALT!);
  // Expired deduplication rows are removed before insert even if general cleanup is busy.
  await db.batch([
    db
      .prepare(
        'DELETE FROM share_reports WHERE share_id = ? AND reporter_hash = ? AND expires_at <= ?',
      )
      .bind(id, reporterHash, now),
    db
      .prepare(
        `INSERT INTO share_reports (share_id, reporter_hash, expires_at)
      VALUES (?, ?, ?) ON CONFLICT (share_id, reporter_hash) DO NOTHING`,
      )
      .bind(id, reporterHash, now + 30 * 86400),
  ]);
  try {
    await cleanupExpired(db, now);
  } catch {
    console.error('Share API expiration cleanup failed.');
  }
  return json({ ok: true });
}

export async function handleRequest(
  request: Request,
  env: Env,
  gameIds: ReadonlySet<string>,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === '/api/config') {
      if (request.method !== 'GET') return methodNotAllowed('GET');
      const enabled = submissionEnabled(url, env);
      return json({
        submissionEnabled: enabled,
        providers: PROVIDERS,
      });
    }
    const gameRoute = /^\/api\/games\/([A-Za-z0-9_-]+)\/shares$/.exec(url.pathname);
    if (gameRoute) {
      const gameId = gameRoute[1];
      if (!gameIds.has(gameId)) throw new ApiError(404, '没有找到这个游戏。');
      if (request.method === 'GET') {
        const page = parsePage(url);
        const db = database(env);
        const { results } = await db
          .prepare(
            `SELECT ${SHARE_COLUMNS} FROM shares
          WHERE game_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
          )
          .bind(gameId, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE)
          .all<Share>();
        return json({
          shares: results.slice(0, PAGE_SIZE),
          page,
          hasMore: results.length > PAGE_SIZE,
        });
      }
      if (request.method === 'POST') return await createShare(request, env, gameId);
      return methodNotAllowed('GET, POST');
    }
    const reportRoute =
      /^\/api\/shares\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/reports$/.exec(
        url.pathname,
      );
    if (reportRoute) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      return await reportShare(request, env, reportRoute[1]);
    }
    return json({ error: '没有找到这个接口。' }, 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error('Share API request failed.');
    return json({ error: '分享服务暂时不可用，请稍后再试。' }, 503);
  }
}

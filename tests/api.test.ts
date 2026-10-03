import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleRequest } from '../worker/api.ts';
import {
  ApiError,
  parsePage,
  readMutation,
  submissionEnabled,
  isLocal,
  validateShare,
} from '../worker/validation.ts';
import type { D1Binding, D1Statement, Env } from '../worker/types.ts';

// Run the production migration and SQL against real SQLite. Wrangler/D1 is also
// checked separately during local preview; these tests need no cloud credentials.
function createDatabase(): D1Binding & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_shares.sql', import.meta.url), 'utf8'));
  function prepare(sql: string, params: (string | number | null)[] = []): D1Statement {
    return {
      bind: (...values) => prepare(sql, values),
      async first<T>() {
        return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: sqlite.prepare(sql).all(...params) as T[] };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...params);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    sqlite,
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

const games = new Set(['sample-game', 'second-game']);
const localOrigin = 'http://localhost:8787';
const sharePath = '/api/games/sample-game/shares';

function localEnv(db: D1Binding): Env {
  return {
    DB: db,
    ENVIRONMENT: 'local',
    RATE_LIMIT_SALT: 'unit-test-only-salt-at-least-32-characters',
  };
}

function post(
  path: string,
  body: Record<string, unknown> = {},
  overrides: RequestInit = {},
): Request {
  return new Request(`${localOrigin}${path}`, {
    method: 'POST',
    headers: { Origin: localOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...overrides,
  });
}

function shareBody(url = 'https://pan.baidu.com/s/1ExampleShare') {
  return {
    url,
    code: 'Ab12',
    version: '简体中文版',
    nickname: '玩家',
    note: '已测试。',
  };
}

test('supported providers produce normalized links and preserve extraction codes', () => {
  const normalized = validateShare({
    url: 'https://pan.baidu.com/s/1ExampleShare/?pwd=abc1&utm_source=test#ignored',
  });
  assert.equal(normalized.url, 'https://pan.baidu.com/s/1ExampleShare');
  assert.equal(normalized.code, 'abc1');
  assert.equal(normalized.provider, 'baidu');
  assert.equal(
    validateShare({ url: 'https://www.aliyundrive.com/s/Abc123' }).url,
    'https://www.alipan.com/s/Abc123',
  );
  assert.equal(validateShare({ url: 'https://123pan.com/s/Abc-123.html' }).provider, '123pan');
  assert.equal(validateShare({ url: 'https://pan.quark.cn/s/abc123' }).provider, 'quark');
  assert.equal(validateShare({ url: 'https://drive.uc.cn/s/abc123' }).provider, 'uc');
});

test('rejects non-share destinations, hostname confusion, credentials, and encoded paths', () => {
  for (const url of [
    'http://pan.baidu.com/s/Abc123',
    'javascript:alert(1)',
    'https://pan.baidu.com.evil.example/s/Abc123',
    'https://evil.example/?url=https://pan.baidu.com/s/Abc123',
    'https://user@pan.baidu.com/s/Abc123',
    'https://pan.baidu.com:8443/s/Abc123',
    'https://pan.baidu.com/login',
    'https://pan.baidu.com/s/%2fetc',
    'https://pan.baidu.com/s/Abc123/more',
    'https://pan.baidu.com\\@evil.example/s/Abc123',
    'https://pan.baidu.com/s/Abc 123',
  ])
    assert.throws(() => validateShare({ url }), ApiError, url);
});

test('text lengths, controls, and extraction code format are enforced', () => {
  assert.throws(() => validateShare({ ...shareBody(), note: '字'.repeat(501) }), ApiError);
  assert.throws(() => validateShare({ ...shareBody(), version: {} }), ApiError);
  assert.throws(() => validateShare({ ...shareBody(), nickname: 'bad\u0000name' }), ApiError);
  assert.throws(() => validateShare({ ...shareBody(), code: '<script>' }), ApiError);
  assert.equal(
    validateShare({ ...shareBody(), note: '  第一行\n第二行  ' }).note,
    '第一行\n第二行',
  );
});

test('page limits bound reads and reject ambiguous values', () => {
  assert.equal(parsePage(new URL(`${localOrigin}${sharePath}`)), 1);
  assert.equal(parsePage(new URL(`${localOrigin}${sharePath}?page=1000`)), 1000);
  for (const page of ['0', '-1', '1.5', '1001', '1e2', '01']) {
    assert.throws(() => parsePage(new URL(`${localOrigin}${sharePath}?page=${page}`)), ApiError);
  }
});

test('submission requires a database and salt, with HTTPS required outside local previews', () => {
  const db = createDatabase();
  const env = localEnv(db);
  assert.equal(submissionEnabled(new URL(localOrigin), env), true);
  for (const origin of ['http://example.com', 'http://localhost.example.com']) {
    assert.equal(submissionEnabled(new URL(origin), env), false);
  }
  for (const broken of [
    { ...env, RATE_LIMIT_SALT: 'short' },
    { ...env, RATE_LIMIT_SALT: undefined },
    { ...env, DB: undefined },
  ]) {
    assert.equal(submissionEnabled(new URL(localOrigin), broken), false);
    assert.equal(submissionEnabled(new URL('https://example.com'), broken), false);
  }
  const production = { ...env, ENVIRONMENT: 'production' };
  assert.equal(submissionEnabled(new URL('https://example.com'), production), true);
  assert.equal(submissionEnabled(new URL('http://example.com'), production), false);
  assert.equal(submissionEnabled(new URL(localOrigin), production), false);
  assert.equal(submissionEnabled(new URL('http://192.168.1.2'), production), false);
  db.sqlite.close();
});

test('local preview identity fallback is restricted to loopback and RFC 1918 IPv4 addresses', () => {
  const env = { ENVIRONMENT: 'local' };
  for (const host of [
    'localhost',
    '127.0.0.1',
    '[::1]',
    '10.0.0.0',
    '10.255.255.255',
    '172.16.0.0',
    '172.31.255.255',
    '192.168.0.0',
    '192.168.255.255',
  ]) {
    assert.equal(isLocal(new URL(`http://${host}:8787`), env), true, host);
    assert.equal(isLocal(new URL(`https://${host}`), { ENVIRONMENT: 'production' }), false, host);
  }
  for (const host of [
    'example.com',
    'localhost.example.com',
    '192.168.1.2.example.com',
    '9.255.255.255',
    '11.0.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.167.255.255',
    '192.169.0.0',
    '100.64.0.1',
    '169.254.1.1',
    '0.0.0.0',
    '203.0.113.1',
    '[fd00::1]',
  ]) {
    assert.equal(isLocal(new URL(`http://${host}:8787`), env), false, host);
  }
});

test('mutation bodies require same-origin JSON and enforce size even without Content-Length', async () => {
  await assert.rejects(
    () =>
      readMutation(
        post(
          sharePath,
          {},
          { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } },
        ),
      ),
    { status: 403 },
  );
  await assert.rejects(
    () => readMutation(post(sharePath, {}, { headers: { 'Content-Type': 'application/json' } })),
    { status: 403 },
  );
  await assert.rejects(
    () =>
      readMutation(
        post(sharePath, {}, { headers: { Origin: localOrigin, 'Content-Type': 'text/plain' } }),
      ),
    { status: 415 },
  );
  await assert.rejects(() => readMutation(post(sharePath, { note: 'a'.repeat(9000) })), {
    status: 413,
  });
  await assert.rejects(() => readMutation(post(sharePath, {}, { body: '[]' })), { status: 400 });
  await assert.rejects(() => readMutation(post(sharePath, {}, { body: '{invalid' })), {
    status: 400,
  });
});

test('routes reject unknown games and unsupported methods before touching storage', async () => {
  assert.equal(
    (await handleRequest(new Request(`${localOrigin}/api/games/missing/shares`), {}, games)).status,
    404,
  );
  const wrongMethod = await handleRequest(
    new Request(`${localOrigin}${sharePath}`, { method: 'DELETE' }),
    {},
    games,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'GET, POST');
  assert.equal(
    (await handleRequest(new Request(`${localOrigin}/api/admin`), {}, games)).status,
    404,
  );
  assert.equal(
    (await handleRequest(new Request(`${localOrigin}${sharePath}`), {}, games)).status,
    503,
  );
  const config = await handleRequest(new Request(`${localOrigin}/api/config`), {}, games);
  assert.deepEqual(await config.json(), {
    submissionEnabled: false,
    shareRateLimitBypassUntil: null,
    providers: [
      { id: 'baidu', label: '百度网盘' },
      { id: 'quark', label: '夸克网盘' },
      { id: 'aliyun', label: '阿里云盘' },
      { id: 'uc', label: 'UC 网盘' },
      { id: '123pan', label: '123 云盘' },
    ],
  });
});

test('a direct share is persisted and immediately publicly listed without external requests; duplicates are rejected per game', async (t) => {
  const outbound = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Submitting a share must not contact an external verification service.');
  });
  const db = createDatabase();
  t.after(() => db.sqlite.close());
  const env = localEnv(db);
  const response = await handleRequest(post(sharePath, shareBody()), env, games);
  assert.equal(response.status, 201);
  const { share } = (await response.json()) as { share: Record<string, unknown> };
  assert.equal(share.gameId, 'sample-game');
  assert.equal(share.reportCount, 0);
  assert.equal(Object.hasOwn(share, 'ip'), false);
  assert.equal(Object.hasOwn(share, 'status'), false);
  const listed = (await (
    await handleRequest(new Request(`${localOrigin}${sharePath}`), env, games)
  ).json()) as { shares: Record<string, unknown>[] };
  assert.equal(listed.shares.length, 1);
  assert.equal(listed.shares[0].id, share.id);
  assert.equal(outbound.mock.callCount(), 0);
  const duplicate = await handleRequest(
    post(sharePath, shareBody('https://pan.baidu.com/s/1ExampleShare?pwd=other#fragment')),
    env,
    games,
  );
  assert.equal(duplicate.status, 409);
  assert.equal(
    (await handleRequest(post('/api/games/second-game/shares', shareBody()), env, games)).status,
    201,
  );
});

test('feedback is idempotent for 30 days and never hides a share', async (t) => {
  const outbound = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Submitting feedback must not contact an external verification service.');
  });
  const db = createDatabase();
  t.after(() => db.sqlite.close());
  const env = localEnv(db);
  const created = (await (
    await handleRequest(post(sharePath, shareBody()), env, games)
  ).json()) as { share: { id: string } };
  const path = `/api/shares/${created.share.id}/reports`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await handleRequest(post(path), env, games);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  const listing = (await (
    await handleRequest(new Request(`${localOrigin}${sharePath}`), env, games)
  ).json()) as { shares: { reportCount: number }[] };
  assert.equal(listing.shares.length, 1);
  assert.equal(listing.shares[0].reportCount, 1);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS total FROM share_reports').get()?.total, 1);
  assert.equal(outbound.mock.callCount(), 0);
});

test('missing configuration and exhausted rate limits cannot write a share', async (t) => {
  const db = createDatabase();
  t.after(() => db.sqlite.close());
  const env = localEnv(db);
  for (const broken of [
    { ...env, DB: undefined },
    { ...env, RATE_LIMIT_SALT: undefined },
    { ...env, RATE_LIMIT_SALT: 'short' },
  ]) {
    assert.equal((await handleRequest(post(sharePath, shareBody()), broken, games)).status, 503);
  }
  assert.equal(db.sqlite.prepare('SELECT count(*) AS total FROM shares').get()?.total, 0);
  for (let index = 0; index < 6; index++) {
    assert.equal(
      (
        await handleRequest(
          post(sharePath, shareBody(`https://pan.baidu.com/s/Example${index}`)),
          env,
          games,
        )
      ).status,
      201,
    );
  }
  assert.equal(
    (
      await handleRequest(
        post(sharePath, shareBody('https://pan.baidu.com/s/OverLimit')),
        env,
        games,
      )
    ).status,
    429,
  );
  assert.equal(db.sqlite.prepare('SELECT count(*) AS total FROM shares').get()?.total, 6);
});

test('temporary share bypass preserves existing counters and ends exactly at its deadline', async (t) => {
  let now = Date.parse('2026-10-03T05:10:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const db = createDatabase();
  t.after(() => db.sqlite.close());
  const env = localEnv(db);
  for (let index = 0; index < 6; index++) {
    assert.equal(
      (
        await handleRequest(
          post(sharePath, shareBody(`https://pan.baidu.com/s/BeforeBypass${index}`)),
          env,
          games,
        )
      ).status,
      201,
    );
  }
  const counters = db.sqlite.prepare('SELECT * FROM rate_limits ORDER BY key').all();
  assert.equal(counters.length, 2);
  const deadline = '2026-10-03T05:20:00.123Z';
  const bypass = { ...env, SHARE_RATE_LIMIT_BYPASS_UNTIL: deadline };
  const config = (await (
    await handleRequest(new Request(`${localOrigin}/api/config`), bypass, games)
  ).json()) as { shareRateLimitBypassUntil: string | null };
  assert.equal(config.shareRateLimitBypassUntil, deadline);
  for (let index = 0; index < 8; index++) {
    assert.equal(
      (
        await handleRequest(
          post(sharePath, shareBody(`https://pan.baidu.com/s/DuringBypass${index}`)),
          bypass,
          games,
        )
      ).status,
      201,
    );
  }
  assert.equal(
    (
      await handleRequest(
        post(sharePath, shareBody('https://pan.baidu.com/s/DuringBypass0?pwd=other')),
        bypass,
        games,
      )
    ).status,
    409,
  );
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM rate_limits ORDER BY key').all(), counters);

  now = Date.parse(deadline) - 1;
  assert.equal(
    (
      await handleRequest(
        post(sharePath, shareBody('https://pan.baidu.com/s/LastMillisecond')),
        bypass,
        games,
      )
    ).status,
    201,
  );
  now += 1;
  assert.equal(
    (
      await handleRequest(
        post(sharePath, shareBody('https://pan.baidu.com/s/AtDeadline')),
        bypass,
        games,
      )
    ).status,
    429,
  );
  const expiredConfig = (await (
    await handleRequest(new Request(`${localOrigin}/api/config`), bypass, games)
  ).json()) as { shareRateLimitBypassUntil: string | null };
  assert.equal(expiredConfig.shareRateLimitBypassUntil, null);
  assert.deepEqual(db.sqlite.prepare('SELECT * FROM rate_limits ORDER BY key').all(), counters);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS total FROM shares').get()?.total, 15);
});

test('absent, invalid, and expired bypass values keep the normal share limits', async (t) => {
  const now = Date.parse('2026-10-03T05:10:00.000Z');
  t.mock.method(Date, 'now', () => now);
  for (const deadline of [undefined, '', 'not-a-date', '2026-10-03T05:09:59.999Z']) {
    const db = createDatabase();
    t.after(() => db.sqlite.close());
    const env = { ...localEnv(db), SHARE_RATE_LIMIT_BYPASS_UNTIL: deadline };
    const config = (await (
      await handleRequest(new Request(`${localOrigin}/api/config`), env, games)
    ).json()) as { shareRateLimitBypassUntil: string | null };
    assert.equal(config.shareRateLimitBypassUntil, null);
    for (let index = 0; index < 7; index++) {
      assert.equal(
        (
          await handleRequest(
            post(sharePath, shareBody(`https://pan.baidu.com/s/Fallback${index}`)),
            env,
            games,
          )
        ).status,
        index < 6 ? 201 : 429,
        `deadline=${String(deadline)}, attempt=${index + 1}`,
      );
    }
    assert.equal(db.sqlite.prepare('SELECT count(*) AS total FROM shares').get()?.total, 6);
  }
});

test('an active share bypass still requires configuration, secure identity, and valid submissions', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-03T05:10:00.000Z'));
  const db = createDatabase();
  t.after(() => db.sqlite.close());
  const env = {
    ...localEnv(db),
    SHARE_RATE_LIMIT_BYPASS_UNTIL: '2026-10-03T06:10:00.000Z',
  };
  for (const broken of [
    { ...env, DB: undefined },
    { ...env, RATE_LIMIT_SALT: undefined },
    { ...env, RATE_LIMIT_SALT: 'short' },
  ]) {
    assert.equal((await handleRequest(post(sharePath, shareBody()), broken, games)).status, 503);
  }
  const production = { ...env, ENVIRONMENT: 'production' };
  for (const [origin, ip] of [
    ['http://example.com', '203.0.113.1'],
    ['https://example.com', ''],
    ['https://example.com', 'a'.repeat(65)],
  ]) {
    const request = new Request(`${origin}${sharePath}`, {
      method: 'POST',
      body: JSON.stringify(shareBody()),
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(ip ? { 'CF-Connecting-IP': ip } : {}),
      },
    });
    assert.equal((await handleRequest(request, production, games)).status, 503);
  }
  for (const [request, status] of [
    [post(sharePath, shareBody(), { headers: { 'Content-Type': 'application/json' } }), 403],
    [post(sharePath, shareBody(), { body: '{invalid' }), 400],
    [post(sharePath, { ...shareBody(), note: 'a'.repeat(9000) }), 413],
    [post(sharePath, shareBody('https://example.com/not-a-share')), 400],
  ] as const) {
    assert.equal((await handleRequest(request, env, games)).status, status);
  }
  assert.equal(db.sqlite.prepare('SELECT count(*) AS total FROM shares').get()?.total, 0);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS total FROM rate_limits').get()?.total, 0);
});

test('public or production mutations require Cloudflare client identity and HTTPS', async (t) => {
  const db = createDatabase();
  t.after(() => db.sqlite.close());
  const local = localEnv(db);
  const production = { ...local, ENVIRONMENT: 'production' };
  const request = (origin: string, ip?: string) =>
    new Request(`${origin}${sharePath}`, {
      method: 'POST',
      body: JSON.stringify(shareBody()),
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(ip ? { 'CF-Connecting-IP': ip } : {}),
      },
    });
  for (const env of [local, production]) {
    assert.equal((await handleRequest(request('https://example.com'), env, games)).status, 503);
    assert.equal(
      (await handleRequest(request('http://example.com', '203.0.113.1'), env, games)).status,
      503,
    );
  }
  assert.equal(
    (await handleRequest(request('https://192.168.1.2'), production, games)).status,
    503,
  );
  assert.equal((await handleRequest(request('https://localhost'), production, games)).status, 503);
  assert.equal(
    (await handleRequest(request('https://example.com', 'a'.repeat(65)), production, games)).status,
    503,
  );
  assert.equal(db.sqlite.prepare('SELECT count(*) AS total FROM shares').get()?.total, 0);
  assert.equal(
    (await handleRequest(request('https://example.com', '203.0.113.1'), production, games)).status,
    201,
  );
});

test('phone LAN previews can post and report without cloud identity or external verification', async (t) => {
  const db = createDatabase();
  t.after(() => db.sqlite.close());
  const env = localEnv(db);
  const origin = 'http://192.168.31.176:8787';
  const request = (path: string, body: Record<string, unknown> = {}) =>
    new Request(`${origin}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { Origin: origin, 'Content-Type': 'application/json' },
    });
  const config = await handleRequest(new Request(`${origin}/api/config`), env, games);
  assert.equal(((await config.json()) as { submissionEnabled: boolean }).submissionEnabled, true);
  const created = await handleRequest(request(sharePath, shareBody()), env, games);
  assert.equal(created.status, 201);
  const { share } = (await created.json()) as { share: { id: string } };
  assert.equal(
    (await handleRequest(request(`/api/shares/${share.id}/reports`), env, games)).status,
    200,
  );
  assert.equal(
    db.sqlite.prepare('SELECT report_count FROM shares WHERE id = ?').get(share.id)?.report_count,
    1,
  );
});

test('feedback limits still apply during an active share bypass and the same IP cannot inflate a feedback count', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-03T05:10:00.000Z'));
  const db = createDatabase();
  t.after(() => db.sqlite.close());
  const env = {
    ...localEnv(db),
    SHARE_RATE_LIMIT_BYPASS_UNTIL: '2026-10-03T06:10:00.000Z',
  };
  const created = await handleRequest(post(sharePath, shareBody()), env, games);
  const { share } = (await created.json()) as { share: { id: string } };
  const path = `/api/shares/${share.id}/reports`;
  for (let index = 0; index < 20; index++) {
    assert.equal((await handleRequest(post(path), env, games)).status, 200);
  }
  assert.equal((await handleRequest(post(path), env, games)).status, 429);
  assert.equal(
    db.sqlite.prepare('SELECT report_count FROM shares WHERE id = ?').get(share.id)?.report_count,
    1,
  );
});

test('storage errors do not expose SQL, bindings, or configuration in public responses', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const db: D1Binding = {
    prepare() {
      throw new Error('SQL_PRIVATE_DETAILS secret=super-secret');
    },
    async batch() {
      return [];
    },
  };
  const response = await handleRequest(
    new Request(`${localOrigin}${sharePath}`),
    localEnv(db),
    games,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: '分享服务暂时不可用，请稍后再试。' });
});

test('pagination returns 20 entries and a correct hasMore indicator', async (t) => {
  const db = createDatabase();
  t.after(() => db.sqlite.close());
  const insert = db.sqlite.prepare(
    `INSERT INTO shares (id, game_id, url, provider, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 21; i++)
    insert.run(
      `share-${i.toString().padStart(2, '0')}`,
      'sample-game',
      `https://pan.baidu.com/s/Example${i}`,
      'baidu',
      '2026-01-01T00:00:00.000Z',
    );
  const first = (await (
    await handleRequest(new Request(`${localOrigin}${sharePath}`), localEnv(db), games)
  ).json()) as { shares: { id: string }[]; hasMore: boolean };
  const second = (await (
    await handleRequest(new Request(`${localOrigin}${sharePath}?page=2`), localEnv(db), games)
  ).json()) as { shares: { id: string }[]; hasMore: boolean };
  assert.equal(first.shares.length, 20);
  assert.equal(first.hasMore, true);
  assert.equal(second.shares.length, 1);
  assert.equal(second.hasMore, false);
  assert.notEqual(first.shares[0].id, second.shares[0].id);
});

test('expired abuse-prevention digests are cleaned up, while feedback totals remain', async (t) => {
  const db = createDatabase();
  t.after(() => db.sqlite.close());
  db.sqlite
    .prepare('INSERT INTO rate_limits (key, hits, expires_at) VALUES (?, ?, ?)')
    .run('expired', 1, 1);
  const env = localEnv(db);
  await handleRequest(post(sharePath, shareBody()), env, games);
  assert.equal(
    db.sqlite.prepare('SELECT key FROM rate_limits WHERE key = ?').get('expired'),
    undefined,
  );
});

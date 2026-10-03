import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncCatalog } from '../scripts/sync-catalog.mjs';

const entry = {
  id: 'sample',
  name: '示例游戏',
  version: 1,
  min_api: 5,
  keywords: 'example',
  description: '首轮测试，待实机验证。',
  cover: 'sample/cover.png',
};
async function fixture(t, profiles = [entry]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autorun-catalog-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const outputRoot = path.join(root, 'site');
  const profileRoot = path.join(sourceRoot, 'wine-nx-probe/profiles');
  await mkdir(path.join(profileRoot, 'sample'), { recursive: true });
  await writeFile(path.join(profileRoot, 'catalog.json'), JSON.stringify({ schema: 3, profiles }));
  const coverBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  await writeFile(path.join(profileRoot, 'sample/cover.png'), coverBytes);
  const readme = '# 原说明\n\n首轮测试，不能由主机构建推断可玩。\n';
  await writeFile(path.join(profileRoot, 'sample/README.zh-CN.md'), readme);
  return { sourceRoot, outputRoot, profileRoot, root, coverBytes, readme };
}

test('imports only a local snapshot, preserving original cover bytes and README', async (t) => {
  const setup = await fixture(t);
  await writeFile(path.join(setup.profileRoot, 'sample/game.dll'), 'do not copy');
  const snapshot = await syncCatalog({ ...setup, importedAt: '2026-10-03T00:00:00.000Z' });
  assert.equal(snapshot.source.kind, 'local');
  assert.equal(snapshot.source.repository, 'https://cnb.cool/PalmMuse/autorun-cn');
  assert.equal(snapshot.games[0].readme, setup.readme);
  assert.equal(snapshot.games[0].verification, 'unverified');
  assert.equal('download' in snapshot.games[0], false);
  assert.deepEqual(
    await readFile(path.join(setup.outputRoot, 'public/covers/sample.png')),
    setup.coverBytes,
  );
  await assert.rejects(readFile(path.join(setup.outputRoot, 'public/covers/game.dll')), {
    code: 'ENOENT',
  });
});

test('missing optional image and README stay explicit', async (t) => {
  const setup = await fixture(t, [{ ...entry, id: 'missing', cover: undefined }]);
  const snapshot = await syncCatalog(setup);
  assert.equal(snapshot.games[0].cover, null);
  assert.equal(snapshot.games[0].readme, '');
});

test('rejects catalog traversal and symlink escapes before any output', async (t) => {
  const setup = await fixture(t, [{ ...entry, cover: 'sample/../../secret.png' }]);
  await assert.rejects(syncCatalog(setup), /Unsafe source path/);
  await writeFile(
    path.join(setup.profileRoot, 'catalog.json'),
    JSON.stringify({ schema: 3, profiles: [entry] }),
  );
  await rm(path.join(setup.profileRoot, 'sample/cover.png'));
  await writeFile(path.join(setup.root, 'outside.png'), 'outside');
  await symlink(
    path.join(setup.root, 'outside.png'),
    path.join(setup.profileRoot, 'sample/cover.png'),
  );
  await assert.rejects(syncCatalog(setup), /escapes profiles/);
  await assert.rejects(readFile(path.join(setup.outputRoot, 'src/data/games.json')), {
    code: 'ENOENT',
  });
});

test('verification requires an explicit note and evidence rather than inference', async (t) => {
  const setup = await fixture(t);
  await mkdir(path.join(setup.outputRoot, 'src/data'), { recursive: true });
  await writeFile(
    path.join(setup.outputRoot, 'src/data/editorial.json'),
    JSON.stringify({ sample: { verification: 'verified' } }),
  );
  await assert.rejects(syncCatalog(setup), /requires editorial evidence/);
});

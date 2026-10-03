#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'https://cnb.cool/PalmMuse/autorun-cn';
const CATEGORIES = new Set(['仙剑系列', '武侠与角色扮演', '动作与冒险', '其他']);
const VERIFICATIONS = new Set(['unverified', 'partial', 'verified']);
const ID = /^[a-z0-9-]{1,63}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function integer(value, label) {
  requireValue(Number.isInteger(value) && value >= 1 && value <= 2147483647, `Invalid ${label}`);
  return value;
}

function field(value, limit, label, allowEmpty = true) {
  requireValue(
    typeof value === 'string' &&
      (allowEmpty || value.length > 0) &&
      Buffer.byteLength(value) < limit &&
      !/[\u0000-\u001f\u007f]/u.test(value),
    `Invalid ${label}`,
  );
  return value;
}

/** Both lexical traversal and symlink escapes are rejected before any copying. */
async function sourceFile(root, relative, { optional = false, maxBytes = 1024 * 1024 } = {}) {
  requireValue(
    typeof relative === 'string' &&
      relative.length > 0 &&
      !path.isAbsolute(relative) &&
      !relative.includes('\\') &&
      !relative.includes('\0') &&
      relative.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Unsafe source path',
  );
  let actual;
  try {
    actual = await realpath(path.join(root, relative));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  const inside = path.relative(root, actual);
  requireValue(
    inside && !inside.startsWith(`..${path.sep}`) && inside !== '..' && !path.isAbsolute(inside),
    `Source path escapes profiles: ${relative}`,
  );
  const metadata = await stat(actual);
  requireValue(
    metadata.isFile() && metadata.size <= maxBytes,
    `Invalid source file or size: ${relative}`,
  );
  return readFile(actual);
}

async function readEditorial(outputRoot) {
  try {
    const editorial = JSON.parse(
      await readFile(path.join(outputRoot, 'src/data/editorial.json'), 'utf8'),
    );
    requireValue(
      editorial && typeof editorial === 'object' && !Array.isArray(editorial),
      'Invalid editorial data',
    );
    return editorial;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function gitProvenance(sourceRoot) {
  try {
    const topLevel = execFileSync('git', ['-C', sourceRoot, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (topLevel !== sourceRoot) return { commit: null, workingTreeDirty: null };
    const commit = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const changes = execFileSync(
      'git',
      ['-C', sourceRoot, 'status', '--porcelain', '--', 'wine-nx-probe/profiles'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return { commit, workingTreeDirty: changes.length > 0 };
  } catch {
    // A source archive is supported, but never described as a verified Git checkout.
    return { commit: null, workingTreeDirty: null };
  }
}

export async function syncCatalog({
  sourceRoot,
  outputRoot = SITE_ROOT,
  importedAt = new Date().toISOString(),
}) {
  requireValue(sourceRoot, 'A source repository is required (--source /path/to/autorun-cn)');
  const root = await realpath(sourceRoot);
  const profileRoot = await realpath(path.join(root, 'wine-nx-probe/profiles'));
  const sourceCatalog = JSON.parse(
    (await sourceFile(profileRoot, 'catalog.json')).toString('utf8'),
  );
  requireValue(
    sourceCatalog.schema === 3 &&
      Array.isArray(sourceCatalog.profiles) &&
      sourceCatalog.profiles.length >= 1 &&
      sourceCatalog.profiles.length <= 128,
    'Invalid source catalog schema/count',
  );
  const editorial = await readEditorial(outputRoot);
  const ids = new Set();
  const covers = [];
  const games = [];
  for (const entry of sourceCatalog.profiles) {
    requireValue(
      typeof entry.id === 'string' && ID.test(entry.id) && !ids.has(entry.id),
      'Invalid/duplicate catalog ID',
    );
    ids.add(entry.id);
    const version = integer(entry.version, `version for ${entry.id}`);
    const minApi = integer(entry.min_api, `API for ${entry.id}`);
    const name = field(entry.name, 96, `name for ${entry.id}`, false);
    const keywords = field(entry.keywords, 192, `keywords for ${entry.id}`);
    const description = field(entry.description, 512, `description for ${entry.id}`);
    const notes = editorial[entry.id] ?? {};
    requireValue(
      notes && typeof notes === 'object' && !Array.isArray(notes),
      `Invalid editorial data for ${entry.id}`,
    );
    const category = notes.category ?? '其他';
    const verification = notes.verification ?? 'unverified';
    const verificationNote =
      notes.verificationNote ??
      '尚未在本站记录完整实机验证；请阅读原适配说明中的适用版本与测试边界。';
    const targetVersion = field(notes.targetVersion ?? '', 512, `target version for ${entry.id}`);
    const knownIssues = notes.knownIssues ?? [];
    requireValue(
      Array.isArray(knownIssues) && knownIssues.length <= 12,
      `Invalid known issues for ${entry.id}`,
    );
    knownIssues.forEach((issue) => field(issue, 1024, `known issue for ${entry.id}`, false));
    requireValue(
      CATEGORIES.has(category) && VERIFICATIONS.has(verification),
      `Invalid editorial category/status for ${entry.id}`,
    );
    field(verificationNote, 2048, `verification note for ${entry.id}`, false);
    requireValue(
      verification === 'unverified' ||
        (typeof notes.evidence === 'string' &&
          notes.evidence.trim() &&
          typeof notes.verificationNote === 'string' &&
          notes.verificationNote.trim()),
      `Verified/partial status requires editorial evidence for ${entry.id}`,
    );
    const readme = await sourceFile(profileRoot, `${entry.id}/README.zh-CN.md`, { optional: true });
    let cover = null;
    if (entry.cover != null) {
      requireValue(
        typeof entry.cover === 'string' && entry.cover.startsWith(`${entry.id}/`),
        `Invalid cover path for ${entry.id}`,
      );
      const extension = path.extname(entry.cover).toLowerCase();
      requireValue(
        ['.png', '.jpg', '.jpeg', '.webp'].includes(extension),
        `Invalid cover extension for ${entry.id}`,
      );
      const bytes = await sourceFile(profileRoot, entry.cover, { maxBytes: 16 * 1024 * 1024 });
      const filename = `${entry.id}${extension}`;
      covers.push({ filename, bytes });
      cover = `/covers/${filename}`;
    }
    games.push({
      id: entry.id,
      name,
      version,
      minApi,
      keywords,
      description,
      cover,
      readme: readme?.toString('utf8') ?? '',
      category,
      verification,
      verificationNote,
      targetVersion,
      knownIssues,
    });
  }
  for (const id of Object.keys(editorial))
    requireValue(ids.has(id), `Editorial ID is absent from source catalog: ${id}`);
  const snapshot = {
    source: { repository: REPOSITORY, ...gitProvenance(root), importedAt, kind: 'local' },
    games,
  };
  // Validate all inputs before writing. Only cover images and the JSON snapshot are copied.
  await mkdir(path.join(outputRoot, 'src/data'), { recursive: true });
  await mkdir(path.join(outputRoot, 'public/covers'), { recursive: true });
  for (const { filename, bytes } of covers)
    await writeFile(path.join(outputRoot, 'public/covers', filename), bytes);
  const destination = path.join(outputRoot, 'src/data/games.json');
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(temporary, destination);
  return snapshot;
}

function parseArgs(args) {
  const values = {};
  const names = { '--source': 'sourceRoot' };
  for (let i = 0; i < args.length; i++) {
    const name = names[args[i]];
    requireValue(
      name && args[i + 1] && !args[i + 1].startsWith('--') && !values[name],
      `Invalid argument: ${args[i]}`,
    );
    values[name] = args[++i];
  }
  values.sourceRoot ??= path.resolve(SITE_ROOT, '../autorun-cn');
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const snapshot = await syncCatalog(parseArgs(process.argv.slice(2)));
    console.log(
      `Imported ${snapshot.games.length} games and ${snapshot.games.filter((game) => game.cover).length} original covers.`,
    );
    console.log(
      'Source README and catalog are a local snapshot; no hardware compatibility is inferred.',
    );
  } catch (error) {
    console.error(`Catalog sync failed: ${error.message}`);
    process.exitCode = 1;
  }
}

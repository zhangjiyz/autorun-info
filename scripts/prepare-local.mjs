import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../.dev.vars', import.meta.url));
if (!existsSync(target)) {
  writeFileSync(
    target,
    [
      '# Only for local development; never commit this file.',
      'ENVIRONMENT="local"',
      `RATE_LIMIT_SALT="${randomBytes(32).toString('hex')}"`,
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  console.log('已创建本地开发配置 .dev.vars（不会提交到 Git）。');
}

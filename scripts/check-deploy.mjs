import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const { config, error } = ts.readConfigFile(
  fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
  ts.sys.readFile,
);
if (error) {
  console.error(
    `wrangler.jsonc 格式不正确：${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`,
  );
  process.exit(1);
}
const problems = [];
if (
  !config.d1_databases?.[0]?.database_id ||
  config.d1_databases[0].database_id.startsWith('00000000')
)
  problems.push('请先在 wrangler.jsonc 填入真实 D1 database_id。');
if (config.vars?.ENVIRONMENT !== 'production') problems.push('部署环境必须为 production。');
try {
  const url = new URL(process.env.SITE_URL || '');
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.hostname === 'localhost' ||
    url.username ||
    url.password
  )
    throw new Error();
} catch {
  problems.push('请设置 SITE_URL 为网站的完整 HTTPS 地址，例如 https://games.example.com。');
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

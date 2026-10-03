import type { Env } from './types.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const PROVIDERS = [
  { id: 'baidu', label: '百度网盘' },
  { id: 'quark', label: '夸克网盘' },
  { id: 'aliyun', label: '阿里云盘' },
  { id: 'uc', label: 'UC 网盘' },
  { id: '123pan', label: '123 云盘' },
] as const;

const HOSTS: Record<string, { provider: string; path: RegExp; canonicalHost?: string }> = {
  'pan.baidu.com': { provider: 'baidu', path: /^\/s\/[A-Za-z0-9_-]{3,128}$/ },
  'pan.quark.cn': { provider: 'quark', path: /^\/s\/[A-Za-z0-9_-]{3,128}$/ },
  'www.alipan.com': { provider: 'aliyun', path: /^\/s\/[A-Za-z0-9_-]{3,128}$/ },
  'www.aliyundrive.com': {
    provider: 'aliyun',
    path: /^\/s\/[A-Za-z0-9_-]{3,128}$/,
    canonicalHost: 'www.alipan.com',
  },
  'drive.uc.cn': { provider: 'uc', path: /^\/s\/[A-Za-z0-9_-]{3,128}$/ },
  'www.123pan.com': { provider: '123pan', path: /^\/s\/[A-Za-z0-9_-]{3,128}(?:\.html)?$/ },
  '123pan.com': {
    provider: '123pan',
    path: /^\/s\/[A-Za-z0-9_-]{3,128}(?:\.html)?$/,
    canonicalHost: 'www.123pan.com',
  },
  'www.123865.com': { provider: '123pan', path: /^\/s\/[A-Za-z0-9_-]{3,128}(?:\.html)?$/ },
  '123865.com': {
    provider: '123pan',
    path: /^\/s\/[A-Za-z0-9_-]{3,128}(?:\.html)?$/,
    canonicalHost: 'www.123865.com',
  },
  'www.123684.com': { provider: '123pan', path: /^\/s\/[A-Za-z0-9_-]{3,128}(?:\.html)?$/ },
  '123684.com': {
    provider: '123pan',
    path: /^\/s\/[A-Za-z0-9_-]{3,128}(?:\.html)?$/,
    canonicalHost: 'www.123684.com',
  },
};

export function isLocal(url: URL, env: Env): boolean {
  if (env.ENVIRONMENT !== 'local') return false;
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
  // Allow a phone on the development machine's LAN without extending the fallback
  // to public hosts or addresses outside the RFC 1918 private IPv4 ranges.
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) return false;
  const parts = url.hostname.split('.').map(Number);
  if (parts.some((part) => part > 255)) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

export function submissionEnabled(url: URL, env: Env): boolean {
  if (!env.DB || (env.RATE_LIMIT_SALT?.length ?? 0) < 32) return false;
  return isLocal(url, env) || url.protocol === 'https:';
}

function textField(body: Record<string, unknown>, key: string, label: string, max: number): string {
  const value = body[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ApiError(400, `${label}格式不正确。`);
  const normalized = value.normalize('NFC').trim();
  if ([...normalized].length > max) throw new ApiError(400, `${label}最多 ${max} 个字符。`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new ApiError(400, `${label}包含不支持的字符。`);
  }
  return normalized;
}

export function validateShare(body: Record<string, unknown>) {
  const rawUrl = textField(body, 'url', '网盘链接', 512);
  if (!rawUrl || /\s|\\/.test(rawUrl)) throw new ApiError(400, '请填写完整的 HTTPS 网盘分享链接。');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiError(400, '网盘链接格式不正确。');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw new ApiError(400, '请使用没有账号信息或自定义端口的 HTTPS 网盘链接。');
  }
  const config = HOSTS[parsed.hostname];
  const path = parsed.pathname.replace(/\/$/, '');
  if (!config || !config.path.test(path)) {
    throw new ApiError(400, '仅支持百度、夸克、阿里、UC 和 123 网盘的 /s/ 分享链接。');
  }
  let code = textField(body, 'code', '提取码', 32);
  if (!code) {
    const urlCode =
      parsed.searchParams.get('pwd') ??
      parsed.searchParams.get('password') ??
      parsed.searchParams.get('passcode') ??
      '';
    code = textField({ code: urlCode }, 'code', '提取码', 32);
  }
  if (code && !/^[A-Za-z0-9_-]+$/.test(code))
    throw new ApiError(400, '提取码只能包含字母、数字、短横线和下划线。');
  // Strip tracking parameters and fragments. The extraction code is stored separately,
  // so alternate query strings cannot be used to post the same link repeatedly.
  return {
    url: `https://${config.canonicalHost ?? parsed.hostname}${path}`,
    provider: config.provider,
    code,
    version: textField(body, 'version', '游戏版本', 80),
    nickname: textField(body, 'nickname', '昵称', 32),
    note: textField(body, 'note', '说明', 500),
  };
}

export function parsePage(url: URL): number {
  const value = url.searchParams.get('page') ?? '1';
  if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > 1000)
    throw new ApiError(400, '页码应为 1 到 1000。');
  return Number(value);
}

export async function readMutation(request: Request): Promise<Record<string, unknown>> {
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin) throw new ApiError(403, '请在本站页面内提交。');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')
    throw new ApiError(403, '请在本站页面内提交。');
  const mediaType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') throw new ApiError(415, '请使用 JSON 提交。');
  if (Number(request.headers.get('Content-Length') ?? '0') > 8192)
    throw new ApiError(413, '提交内容太长。');
  if (!request.body) throw new ApiError(400, '提交内容不能为空。');
  const reader = request.body.getReader();
  let byteLength = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > 8192) {
        await reader.cancel();
        throw new ApiError(413, '提交内容太长。');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, '提交内容不是有效的 JSON。');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new ApiError(400, '提交内容格式不正确。');
  return body as Record<string, unknown>;
}

/** The subset of the D1 binding used by this API, without adding browser globals. */
export interface D1Statement {
  bind(...values: (string | number | null)[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface D1Binding {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

export interface Env {
  DB?: D1Binding;
  RATE_LIMIT_SALT?: string;
  SHARE_RATE_LIMIT_BYPASS_UNTIL?: string;
  ENVIRONMENT?: string;
}

export interface Share {
  id: string;
  gameId: string;
  url: string;
  provider: string;
  code: string;
  version: string;
  nickname: string;
  note: string;
  createdAt: string;
  reportCount: number;
}

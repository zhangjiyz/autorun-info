CREATE TABLE IF NOT EXISTS shares ( id TEXT PRIMARY KEY, game_id TEXT NOT NULL, url TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('baidu', 'quark', 'aliyun', 'uc', '123pan')), code TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '', nickname TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, report_count INTEGER NOT NULL DEFAULT 0 CHECK (report_count >= 0), UNIQUE (game_id, url) );
CREATE INDEX IF NOT EXISTS shares_game_created ON shares (game_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS rate_limits ( key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL );
CREATE INDEX IF NOT EXISTS rate_limits_expiration ON rate_limits (expires_at);
CREATE TABLE IF NOT EXISTS share_reports ( share_id TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE, reporter_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (share_id, reporter_hash) );
CREATE INDEX IF NOT EXISTS share_reports_expiration ON share_reports (expires_at);
CREATE TRIGGER IF NOT EXISTS increment_share_reports AFTER INSERT ON share_reports BEGIN UPDATE shares SET report_count = report_count + 1 WHERE id = NEW.share_id; END;

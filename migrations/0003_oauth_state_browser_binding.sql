-- 기존 state는 시작 브라우저를 증명할 수 없으므로 폐기하고, 이후 행은
-- 브라우저 임시 쿠키의 해시를 반드시 갖게 한다.

CREATE TABLE oauth_states_with_browser (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  browser_secret_hash TEXT NOT NULL,
  redirect_to TEXT NOT NULL DEFAULT '/',
  expires_at INTEGER NOT NULL
) STRICT;

DROP TABLE oauth_states;

ALTER TABLE oauth_states_with_browser RENAME TO oauth_states;

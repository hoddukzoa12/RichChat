-- conversations와 messages는 서로를 참조한다. 새 대화는 last_message_id=NULL로
-- 먼저 INSERT하고, 메시지를 INSERT한 뒤 포인터를 UPDATE하는 순서를 같은 ordered
-- batch에서 지켜야 한다. 미래 메시지 포인터를 먼저 쓰거나 메시지를 먼저 넣으면 실패한다.

CREATE TABLE offices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email_domain TEXT,
  event_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_offices_email_domain
  ON offices(email_domain)
  WHERE email_domain IS NOT NULL;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  office_id TEXT NOT NULL REFERENCES offices(id),
  email TEXT NOT NULL,
  works_sub TEXT,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('관리자', '세무사', '상담 담당')),
  status TEXT NOT NULL DEFAULT '초대'
    CHECK (status IN ('초대', '활성', '비활성')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_users_email ON users(email);
CREATE UNIQUE INDEX ux_users_works_sub
  ON users(works_sub)
  WHERE works_sub IS NOT NULL;
CREATE UNIQUE INDEX ux_users_id_office
  ON users(id, office_id);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  notify_new_chat INTEGER NOT NULL CHECK (notify_new_chat IN (0, 1)),
  notify_mine_only INTEGER NOT NULL CHECK (notify_mine_only IN (0, 1)),
  notify_sound INTEGER NOT NULL CHECK (notify_sound IN (0, 1)),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE office_settings (
  office_id TEXT PRIMARY KEY REFERENCES offices(id),
  export_log INTEGER NOT NULL CHECK (export_log IN (0, 1)),
  retention_years INTEGER NOT NULL DEFAULT 5,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (updated_by, office_id)
    REFERENCES users(id, office_id)
) STRICT;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  office_id TEXT NOT NULL REFERENCES offices(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (user_id, office_id)
    REFERENCES users(id, office_id)
) STRICT;

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_to TEXT NOT NULL DEFAULT '/',
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  office_id TEXT NOT NULL REFERENCES offices(id),
  phone_e164 TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  role_title TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_customers_phone
  ON customers(office_id, phone_e164);
CREATE UNIQUE INDEX ux_customers_id_office
  ON customers(id, office_id);

CREATE TABLE customer_fields (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  office_id TEXT NOT NULL REFERENCES offices(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  UNIQUE (customer_id, key),
  FOREIGN KEY (customer_id, office_id)
    REFERENCES customers(id, office_id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by, office_id)
    REFERENCES users(id, office_id)
) STRICT;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  office_id TEXT NOT NULL REFERENCES offices(id),
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '미처리'
    CHECK (status IN ('미처리', '처리중', '완료')),
  label TEXT NOT NULL DEFAULT '',
  archived_at INTEGER,
  last_message_id TEXT,
  last_message_at INTEGER,
  inbound_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (customer_id, office_id)
    REFERENCES customers(id, office_id),
  FOREIGN KEY (last_message_id, id)
    REFERENCES messages(id, conversation_id)
) STRICT;

CREATE UNIQUE INDEX ux_conv_customer
  ON conversations(office_id, customer_id);
CREATE UNIQUE INDEX ux_conversations_id_office
  ON conversations(id, office_id);
CREATE INDEX ix_conversations_active_last_message
  ON conversations(office_id, last_message_at DESC)
  WHERE archived_at IS NULL;
CREATE INDEX ix_conversations_archived_last_message
  ON conversations(office_id, last_message_at DESC)
  WHERE archived_at IS NOT NULL;

CREATE TABLE conversation_assignees (
  conversation_id TEXT NOT NULL,
  office_id TEXT NOT NULL REFERENCES offices(id),
  user_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  assigned_by TEXT,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, office_id)
    REFERENCES conversations(id, office_id),
  FOREIGN KEY (user_id, office_id)
    REFERENCES users(id, office_id),
  FOREIGN KEY (assigned_by, office_id)
    REFERENCES users(id, office_id)
) STRICT;

CREATE TABLE conversation_reads (
  conversation_id TEXT NOT NULL,
  office_id TEXT NOT NULL REFERENCES offices(id),
  user_id TEXT NOT NULL,
  read_inbound_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, office_id)
    REFERENCES conversations(id, office_id),
  FOREIGN KEY (user_id, office_id)
    REFERENCES users(id, office_id)
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  office_id TEXT NOT NULL REFERENCES offices(id),
  conversation_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  channel TEXT NOT NULL CHECK (channel IN ('SMS', 'LMS', 'MMS')),
  title TEXT,
  body TEXT NOT NULL,
  sender_user_id TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  mo_key TEXT,
  client_key TEXT,
  msg_key TEXT,
  delivery_status TEXT NOT NULL,
  result_code TEXT,
  delivered_at INTEGER,
  error_text TEXT,
  FOREIGN KEY (conversation_id, office_id)
    REFERENCES conversations(id, office_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_user_id, office_id)
    REFERENCES users(id, office_id),
  CHECK (direction = 'in' OR sender_user_id IS NOT NULL),
  CHECK (direction = 'in' OR client_key IS NOT NULL),
  CHECK (direction = 'out' OR mo_key IS NOT NULL),
  CHECK (
    (direction = 'in' AND delivery_status = '수신')
    OR (
      direction = 'out'
      AND delivery_status IN ('대기', '접수', '전송중', '완료', '실패')
    )
  )
) STRICT;

CREATE UNIQUE INDEX ux_msg_mo_key
  ON messages(mo_key)
  WHERE mo_key IS NOT NULL;
CREATE UNIQUE INDEX ux_msg_client_key
  ON messages(client_key)
  WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX ux_msg_msg_key
  ON messages(msg_key)
  WHERE msg_key IS NOT NULL;
CREATE UNIQUE INDEX ux_messages_id_conversation
  ON messages(id, conversation_id);
CREATE INDEX ix_messages_conversation_occurred
  ON messages(conversation_id, occurred_at, id);
CREATE INDEX ix_messages_pending
  ON messages(delivery_status, created_at)
  WHERE delivery_status IN ('대기', '접수', '전송중');

CREATE TABLE mo_failures (
  mo_key TEXT PRIMARY KEY,
  raw_json TEXT NOT NULL,
  error_text TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
) STRICT;

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  office_id TEXT NOT NULL REFERENCES offices(id),
  conversation_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (conversation_id, office_id)
    REFERENCES conversations(id, office_id) ON DELETE CASCADE,
  FOREIGN KEY (author_id, office_id)
    REFERENCES users(id, office_id)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  office_id TEXT NOT NULL REFERENCES offices(id),
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sub TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('warn', 'idle', 'done')),
  sort_order INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (conversation_id, office_id)
    REFERENCES conversations(id, office_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by, office_id)
    REFERENCES users(id, office_id)
) STRICT;

CREATE TABLE office_channels (
  id TEXT PRIMARY KEY,
  office_id TEXT NOT NULL REFERENCES offices(id),
  value TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_channel_default
  ON office_channels(office_id)
  WHERE is_default = 1;

CREATE TABLE lgu_tokens (
  office_id TEXT PRIMARY KEY REFERENCES offices(id),
  access_token TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  office_id TEXT NOT NULL REFERENCES offices(id),
  office_seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  conversation_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'customer', 'system')),
  actor_id TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id, office_id)
    REFERENCES conversations(id, office_id),
  FOREIGN KEY (actor_id, office_id)
    REFERENCES users(id, office_id)
) STRICT;

CREATE UNIQUE INDEX ux_events_office_seq
  ON events(office_id, office_seq);

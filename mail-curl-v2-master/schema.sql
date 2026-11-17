-- Mail Curl D1 schema
-- 运行: npx wrangler d1 execute mail-curl-db --remote --file schema.sql

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS mails (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id)
);

CREATE INDEX IF NOT EXISTS idx_mails_mailbox_id ON mails(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_mailboxes_created_at ON mailboxes(created_at);

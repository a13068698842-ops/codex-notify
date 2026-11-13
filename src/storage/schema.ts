// Append migrations in order. Keep migrations and PRAGMA user_version in the same transaction.
export const migrations = [`
  CREATE TABLE sessions (
    host_id TEXT NOT NULL CHECK (host_id = 'local'),
    thread_id TEXT NOT NULL,
    title TEXT NOT NULL,
    project TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('hook', 'manual')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    transcript_path TEXT,
    observed_offset INTEGER NOT NULL CHECK (observed_offset >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (host_id, thread_id)
  ) STRICT;

  CREATE TABLE questions (
    id TEXT PRIMARY KEY NOT NULL,
    host_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('native', 'plain')),
    request_method TEXT NOT NULL,
    request_id_type TEXT NOT NULL,
    request_id_json TEXT NOT NULL,
    frozen_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'submitting', 'failed', 'unknown', 'answered')),
    version INTEGER NOT NULL CHECK (version >= 0),
    code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'plain' AND request_method = '' AND request_id_type = '' AND request_id_json = '') OR
           (kind = 'native' AND request_method = 'item/tool/requestUserInput' AND request_id_type IN ('string', 'number'))),
    FOREIGN KEY (host_id, thread_id) REFERENCES sessions (host_id, thread_id),
    UNIQUE (host_id, thread_id, turn_id, item_id, kind, request_method, request_id_type, request_id_json)
  ) STRICT;

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    question_id TEXT NOT NULL REFERENCES questions (id),
    channel TEXT NOT NULL,
    account_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    message_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
    published_version INTEGER NOT NULL CHECK (published_version >= 0),
    code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((state = 'sent') = (message_id IS NOT NULL)),
    UNIQUE (id, question_id),
    UNIQUE (question_id, channel, account_id, target_id),
    UNIQUE (channel, account_id, message_id)
  ) STRICT;

  CREATE TABLE submissions (
    sequence INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    question_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    event_id TEXT,
    operator_id TEXT NOT NULL,
    answer_hash TEXT NOT NULL,
    answers_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    bridge_request_id TEXT NOT NULL UNIQUE,
    client_user_message_id TEXT UNIQUE,
    returned_turn_id TEXT,
    phase TEXT NOT NULL CHECK (phase IN ('queued', 'dispatching', 'awaiting_receipt', 'failed', 'unknown', 'answered')),
    receipt_json TEXT,
    code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((phase = 'answered') = (receipt_json IS NOT NULL)),
    FOREIGN KEY (delivery_id, question_id) REFERENCES deliveries (id, question_id)
  ) STRICT;

  CREATE INDEX submission_answers ON submissions (question_id, answer_hash);
  CREATE UNIQUE INDEX one_live_submission_per_question ON submissions (question_id) WHERE phase <> 'failed';

  -- Also keep event IDs for duplicates observed while the original attempt is active.
  -- A retry of such a callback must not claim the question after a known failure.
  CREATE TABLE submission_events (
    channel TEXT NOT NULL,
    account_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL REFERENCES deliveries (id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (channel, account_id, event_id)
  ) STRICT;
`, `
  CREATE TABLE registrations (
    thread_id TEXT PRIMARY KEY NOT NULL,
    cwd TEXT,
    transcript_path TEXT,
    source TEXT NOT NULL CHECK (source IN ('hook', 'manual')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
  ) STRICT;
`, `
  CREATE TABLE questions_v3 (
    id TEXT PRIMARY KEY NOT NULL,
    host_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('native', 'plain', 'async')),
    request_method TEXT NOT NULL,
    request_id_type TEXT NOT NULL,
    request_id_json TEXT NOT NULL,
    frozen_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'submitting', 'failed', 'unknown', 'answered')),
    version INTEGER NOT NULL CHECK (version >= 0),
    code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind IN ('plain', 'async') AND request_method = '' AND request_id_type = '' AND request_id_json = '') OR
           (kind = 'native' AND request_method = 'item/tool/requestUserInput' AND request_id_type IN ('string', 'number'))),
    FOREIGN KEY (host_id, thread_id) REFERENCES sessions (host_id, thread_id),
    UNIQUE (host_id, thread_id, turn_id, item_id, kind, request_method, request_id_type, request_id_json)
  ) STRICT;
  INSERT INTO questions_v3 SELECT * FROM questions;
  DROP TABLE questions;
  ALTER TABLE questions_v3 RENAME TO questions;
  ALTER TABLE submissions ADD COLUMN async_route TEXT CHECK (async_route IN ('steer', 'start'));
  ALTER TABLE submissions ADD COLUMN async_mapping_json TEXT;
`];

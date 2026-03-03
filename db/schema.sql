-- ============================================
-- Therian Chat — Schema PostgreSQL
-- Execute this in Railway Query Console
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,        -- Google sub ID
  name        TEXT NOT NULL,
  photo       TEXT,                    -- base64 or URL
  email       TEXT,
  premium     BOOLEAN DEFAULT false,
  is_banned   BOOLEAN DEFAULT false,
  desc_text   TEXT DEFAULT '',
  theriotype  TEXT DEFAULT '',
  last_seen   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  room_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL CHECK (char_length(text) <= 500),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS dm_messages (
  id          SERIAL PRIMARY KEY,
  chat_id     TEXT NOT NULL,           -- uid1_uid2 sorted
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL CHECK (char_length(text) <= 500),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  read_at     TIMESTAMPTZ DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_chat ON dm_messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS friends (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id            SERIAL PRIMARY KEY,
  msg_id        TEXT,
  msg_text      TEXT,
  reported_uid  TEXT,
  reported_name TEXT,
  reporter_uid  TEXT,
  room_id       TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  resolved      BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id          SERIAL PRIMARY KEY,
  from_uid    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_uid      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_uid, to_uid)
);

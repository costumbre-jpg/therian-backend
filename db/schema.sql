-- ============================================
-- Therian Chat — Schema PostgreSQL
-- Ejecutar esto en Railway Query Console
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,        -- Firebase UID
  name        TEXT NOT NULL,
  photo       TEXT,                    -- base64 o URL
  email       TEXT,
  premium     BOOLEAN DEFAULT false,
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
  chat_id     TEXT NOT NULL,           -- uid1_uid2 ordenados
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL CHECK (char_length(text) <= 500),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_chat ON dm_messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS friends (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id)
);

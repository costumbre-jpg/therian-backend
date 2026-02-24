// Execute this script ONCE to create tables in Railway
// Usage: node setup-db.js postgresql://...YOUR_URL_HERE...

const { Pool } = require("pg");

const url = process.argv[2];
if (!url) {
  console.error("❌ Usage: node setup-db.js postgresql://user:password@host:port/dbname");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const sql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  photo TEXT,
  email TEXT,
  premium BOOLEAN DEFAULT false,
  is_banned BOOLEAN DEFAULT false,
  desc_text TEXT DEFAULT '',
  theriotype TEXT DEFAULT '',
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (char_length(text) <= 500),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS dm_messages (
  id SERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (char_length(text) <= 500),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dm_messages_chat ON dm_messages(chat_id, created_at);

CREATE TABLE IF NOT EXISTS friends (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  msg_id TEXT,
  msg_text TEXT,
  reported_uid TEXT,
  reported_name TEXT,
  reporter_uid TEXT,
  room_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

pool.query(sql)
  .then(() => {
    console.log("✅ All tables created successfully in PostgreSQL");
    process.exit(0);
  })
  .catch(err => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });

// Ejecuta este script UNA SOLA VEZ para crear las tablas en Railway
// Uso: node setup-db.js postgresql://...TU_URL_AQUI...

const { Pool } = require("pg");

const url = process.argv[2];
if (!url) {
  console.error("❌ Usa: node setup-db.js postgresql://usuario:password@host:puerto/dbname");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const sql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  photo TEXT,
  email TEXT,
  premium BOOLEAN DEFAULT false,
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id SERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS friends (
  user_id TEXT REFERENCES users(id),
  friend_id TEXT REFERENCES users(id),
  PRIMARY KEY (user_id, friend_id)
);
`;

pool.query(sql)
  .then(() => {
    console.log("✅ Tablas creadas correctamente en Railway PostgreSQL");
    process.exit(0);
  })
  .catch(err => {
    console.error("❌ Error:", err.message);
    process.exit(1);
  });

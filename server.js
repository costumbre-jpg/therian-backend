// ============================================
// Therian Chat  Backend Server v2
// Node.js + Express + Socket.io + PostgreSQL
// Google Identity Services (sin Firebase)
// ============================================

const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const cors     = require("cors");
const { Pool } = require("pg");
const jwt      = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const PORT         = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://therianworld.netlify.app";
const JWT_SECRET      = process.env.JWT_SECRET      || "therian_secret_change_this_in_production";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ADMIN_UID        = process.env.ADMIN_UID || "";
const googleClient     = new OAuth2Client(GOOGLE_CLIENT_ID);

// ---- POSTGRESQL ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "",
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

if (process.env.DATABASE_URL) {
  pool.query("SELECT 1").then(() => console.log("OK PostgreSQL"))
    .catch(err => console.error("ERROR PostgreSQL:", err.message));
  // Agregar columna is_banned si no existe
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE`).catch(() => {});
} else {
  console.warn("WARN: DATABASE_URL no configurada");
}

// ---- EXPRESS ----
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "5mb" }));

app.get("/", (req, res) => res.json({ status: "ok", app: "Therian Chat API v2" }));

// ---- DIAGNÓSTICO TEMPORAL ----
app.get("/api/debug-env", (req, res) => {
  res.json({
    has_google_client_id: !!process.env.GOOGLE_CLIENT_ID,
    google_client_id_length: (process.env.GOOGLE_CLIENT_ID || "").length,
    has_database_url: !!process.env.DATABASE_URL,
    has_jwt_secret: !!process.env.JWT_SECRET,
    node_env: process.env.NODE_ENV || "not set"
  });
});

// ---- VERIFICAR TOKEN DE GOOGLE con librería oficial ----
async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID || undefined  // si no hay CLIENT_ID configurado, igual verifica
  });
  const payload = ticket.getPayload();
  // payload tiene: sub, email, name, picture
  return payload;
}

// ---- MIDDLEWARE: verificar nuestro JWT ----
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autorizado" });
  }
  try {
    const decoded = jwt.verify(header.split(" ")[1], JWT_SECRET);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Token invalido o expirado" });
  }
}

// ---- MIDDLEWARE: solo admin ----
function adminMiddleware(req, res, next) {
  if (!ADMIN_UID || req.uid !== ADMIN_UID) return res.status(403).json({ error: "No autorizado" });
  next();
}

// ============================================================
// RUTAS
// ============================================================

// ---- LOGIN CON GOOGLE (intercambia id_token de Google por nuestro JWT) ----
app.post("/api/auth/google", async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: "idToken requerido" });
  try {
    const gUser = await verifyGoogleToken(idToken);
    const uid   = gUser.sub; // ID unico de Google

    // Upsert usuario en PostgreSQL
    const { rows } = await pool.query(
      `INSERT INTO users (id, name, photo, email, last_seen)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE
         SET last_seen = NOW(),
             photo = COALESCE(EXCLUDED.photo, users.photo)
       RETURNING *`,
      [uid, gUser.name || "Anonymous Therian", gUser.picture || "", gUser.email || ""]
    );
    const user = rows[0];

    // Bloquear usuarios baneados
    if (user.is_banned) return res.status(403).json({ error: "Tu cuenta ha sido baneada de Therians." });

    // Emitir nuestro propio JWT (valido 30 dias)
    const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user });
  } catch (err) {
    console.error("Auth error:", err.message);
    res.status(401).json({ error: err.message });
  }
});

// ---- PERFIL ----
app.get("/api/users/me", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.uid]);
    if (!rows.length) return res.status(404).json({ error: "Usuario no encontrado" });
    const user = rows[0];
    user.is_admin = !!(ADMIN_UID && req.uid === ADMIN_UID);
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ACTUALIZAR NOMBRE ----
app.put("/api/users/me/name", authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name || name.length > 40) return res.status(400).json({ error: "Nombre invalido" });
  try {
    await pool.query("UPDATE users SET name = $1 WHERE id = $2", [name, req.uid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ACTUALIZAR FOTO (base64) ----
app.put("/api/users/me/photo", authMiddleware, async (req, res) => {
  const { photo } = req.body;
  if (!photo) return res.status(400).json({ error: "Foto requerida" });
  try {
    await pool.query("UPDATE users SET photo = $1 WHERE id = $2", [photo, req.uid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- MENSAJES DE SALA ----
app.get("/api/rooms/:roomId/messages", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.room_id, m.user_id, m.text, m.created_at,
              u.name, u.photo, u.premium
       FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.room_id = $1 ORDER BY m.created_at ASC LIMIT 80`,
      [req.params.roomId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- MENSAJES DM ----
app.get("/api/dms/:chatId/messages", authMiddleware, async (req, res) => {
  const uids = req.params.chatId.split("_");
  if (!uids.includes(req.uid)) return res.status(403).json({ error: "Acceso denegado" });
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.chat_id, m.user_id, m.text, m.created_at,
              u.name, u.photo, u.premium
       FROM dm_messages m JOIN users u ON u.id = m.user_id
       WHERE m.chat_id = $1 ORDER BY m.created_at ASC LIMIT 80`,
      [req.params.chatId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- AMIGOS ----
app.get("/api/friends", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.photo, u.premium, u.last_seen
       FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1`,
      [req.uid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- BUSCAR USUARIO POR ID ----
app.get("/api/users/lookup/:uid", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, photo FROM users WHERE id = $1", [req.params.uid]
    );
    if (!rows.length) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- AGREGAR AMIGO ----
app.post("/api/friends/:friendId", authMiddleware, async (req, res) => {
  const { friendId } = req.params;
  if (friendId === req.uid) return res.status(400).json({ error: "No puedes agregarte a ti mismo" });
  try {
    await pool.query(
      `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
      [req.uid, friendId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ADMIN: BAN / UNBAN / BORRAR MENSAJE
// ============================================================

// Banear usuario
app.post("/api/admin/ban/:uid", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await pool.query("UPDATE users SET is_banned = TRUE WHERE id = $1", [req.params.uid]);
    // Desconectar su socket si está conectado
    connectedUsers.forEach((u, socketId) => {
      if (u.uid === req.params.uid) {
        io.to(socketId).emit("banned");
        const s = io.sockets.sockets.get(socketId);
        if (s) s.disconnect(true);
      }
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Desbanear usuario
app.post("/api/admin/unban/:uid", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await pool.query("UPDATE users SET is_banned = FALSE WHERE id = $1", [req.params.uid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Borrar mensaje de sala
app.delete("/api/admin/messages/:msgId", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("DELETE FROM messages WHERE id = $1 RETURNING room_id", [req.params.msgId]);
    if (rows.length) io.to("room_" + rows[0].room_id).emit("message_deleted", req.params.msgId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SOCKET.IO
// ============================================================
const connectedUsers = new Map();

io.on("connection", (socket) => {

  socket.on("auth", (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      pool.query("SELECT * FROM users WHERE id = $1", [decoded.uid]).then(({ rows }) => {
        if (!rows.length) return socket.emit("auth_error", "Usuario no encontrado");
        const user = rows[0];
        if (user.is_banned) return socket.emit("banned");
        connectedUsers.set(socket.id, { uid: user.id, name: user.name, photo: user.photo, premium: user.premium });
        socket.emit("auth_ok");
        pool.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [user.id]).catch(() => {});
      });
    } catch (err) {
      socket.emit("auth_error", "Token invalido");
    }
  });

  socket.on("join_room", (roomId) => {
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join("room_" + roomId);
  });

  socket.on("join_dm", (chatId) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !chatId.split("_").includes(user.uid)) return;
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join("dm_" + chatId);
  });

  socket.on("send_message", async ({ roomId, text }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !text || !text.trim() || text.length > 500) return;
    try {
      const { rows } = await pool.query(
        `INSERT INTO messages (room_id, user_id, text, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *`,
        [roomId, user.uid, text.trim()]
      );
      io.to("room_" + roomId).emit("new_message", {
        id: rows[0].id, room_id: roomId, user_id: user.uid,
        name: user.name, photo: user.photo, premium: user.premium,
        text: rows[0].text, created_at: rows[0].created_at
      });
    } catch (err) { socket.emit("message_error", err.message); }
  });

  socket.on("send_dm", async ({ chatId, text }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !text || !text.trim() || text.length > 500) return;
    if (!chatId.split("_").includes(user.uid)) return;
    try {
      const { rows } = await pool.query(
        `INSERT INTO dm_messages (chat_id, user_id, text, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *`,
        [chatId, user.uid, text.trim()]
      );
      io.to("dm_" + chatId).emit("new_dm", {
        id: rows[0].id, chat_id: chatId, user_id: user.uid,
        name: user.name, photo: user.photo, premium: user.premium,
        text: rows[0].text, created_at: rows[0].created_at
      });
    } catch (err) { socket.emit("message_error", err.message); }
  });

  socket.on("disconnect", () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      pool.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [user.uid]).catch(() => {});
      connectedUsers.delete(socket.id);
    }
  });
});

server.listen(PORT, () => console.log("Therian backend puerto " + PORT));

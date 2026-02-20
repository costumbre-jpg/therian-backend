// ============================================
// Therian Chat — Backend Server
// Node.js + Express + Socket.io + PostgreSQL
// ============================================

const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const cors     = require("cors");
const { Pool } = require("pg");
const admin    = require("firebase-admin");

// ---- CONFIG ----
const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://therianworld.netlify.app";

// ---- FIREBASE ADMIN (para verificar tokens de Google Auth) ----
// Usamos las credenciales como variables de entorno en Railway
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
      : undefined
  })
});

// ---- POSTGRESQL ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

// Test de conexión al inicio
pool.query("SELECT 1").then(() => {
  console.log("✅ PostgreSQL conectado");
}).catch(err => {
  console.error("❌ Error PostgreSQL:", err.message);
});

// ---- EXPRESS ----
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: FRONTEND_URL, methods: ["GET", "POST"] }
});

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json({ limit: "5mb" })); // 5MB para fotos base64

app.get("/", (req, res) => res.json({ status: "ok", app: "Therian Chat API" }));

// ---- MIDDLEWARE: verificar token Firebase ----
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autorizado" });
  }
  try {
    const token = header.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Token inválido" });
  }
}

// ============================================================
// RUTAS HTTP
// ============================================================

// ---- UPSERT DE USUARIO al login ----
app.post("/api/users/login", authMiddleware, async (req, res) => {
  const { name, photo, email } = req.body;
  try {
    await pool.query(
      `INSERT INTO users (id, name, photo, email, last_seen)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE
         SET last_seen = NOW(), name = COALESCE(EXCLUDED.name, users.name)`,
      [req.uid, name, photo, email]
    );
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.uid]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- OBTENER PERFIL ----
app.get("/api/users/:uid", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.uid]);
    if (!rows.length) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- ACTUALIZAR NOMBRE ----
app.put("/api/users/me/name", authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name || name.length > 40) return res.status(400).json({ error: "Nombre inválido" });
  try {
    await pool.query("UPDATE users SET name = $1 WHERE id = $2", [name, req.uid]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- ACTUALIZAR FOTO (base64) ----
app.put("/api/users/me/photo", authMiddleware, async (req, res) => {
  const { photo } = req.body;
  if (!photo) return res.status(400).json({ error: "Foto requerida" });
  try {
    await pool.query("UPDATE users SET photo = $1 WHERE id = $2", [photo, req.uid]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- MENSAJES DE SALA: últimos 80 ----
app.get("/api/rooms/:roomId/messages", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.room_id, m.user_id, m.text, m.created_at,
              u.name, u.photo, u.premium
       FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.room_id = $1
       ORDER BY m.created_at ASC
       LIMIT 80`,
      [req.params.roomId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- MENSAJES DE DM: últimos 80 ----
app.get("/api/dms/:chatId/messages", authMiddleware, async (req, res) => {
  // Verificar que el usuario pertenece a este chat
  const uids = req.params.chatId.split("_");
  if (!uids.includes(req.uid)) return res.status(403).json({ error: "Acceso denegado" });
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.chat_id, m.user_id, m.text, m.created_at,
              u.name, u.photo, u.premium
       FROM dm_messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.chat_id = $1
       ORDER BY m.created_at ASC
       LIMIT 80`,
      [req.params.chatId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- LISTA DE AMIGOS ----
app.get("/api/friends", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.photo, u.premium, u.last_seen
       FROM friends f
       JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = $1`,
      [req.uid]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- BUSCAR USUARIO POR ID (para agregar amigo) ----
app.get("/api/users/lookup/:uid", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, photo FROM users WHERE id = $1",
      [req.params.uid]
    );
    if (!rows.length) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- AGREGAR AMIGO (bidireccional) ----
app.post("/api/friends/:friendId", authMiddleware, async (req, res) => {
  const { friendId } = req.params;
  if (friendId === req.uid) return res.status(400).json({ error: "No puedes agregarte a ti mismo" });
  try {
    await pool.query(
      `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2), ($2, $1)
       ON CONFLICT DO NOTHING`,
      [req.uid, friendId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SOCKET.IO — MENSAJERÍA EN TIEMPO REAL
// ============================================================

// Usuarios conectados: socketId → { uid, name, photo, premium }
const connectedUsers = new Map();

io.on("connection", (socket) => {

  // ---- AUTENTICAR SOCKET ----
  socket.on("auth", async (token) => {
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [decoded.uid]);
      if (!rows.length) return socket.emit("auth_error", "Usuario no encontrado");
      const user = rows[0];
      connectedUsers.set(socket.id, { uid: user.id, name: user.name, photo: user.photo, premium: user.premium });
      socket.emit("auth_ok", { uid: user.id, name: user.name, photo: user.photo, premium: user.premium });
      console.log(`✅ ${user.name} conectado`);
    } catch (err) {
      socket.emit("auth_error", "Token inválido");
    }
  });

  // ---- UNIRSE A SALA ----
  socket.on("join_room", (roomId) => {
    // Salir de todas las salas anteriores (excepto su propia sala de socket)
    socket.rooms.forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });
    socket.join("room_" + roomId);
  });

  // ---- UNIRSE A DM ----
  socket.on("join_dm", (chatId) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    const uids = chatId.split("_");
    if (!uids.includes(user.uid)) return; // seguridad
    socket.rooms.forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });
    socket.join("dm_" + chatId);
  });

  // ---- ENVIAR MENSAJE A SALA ----
  socket.on("send_message", async ({ roomId, text }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !text || !text.trim()) return;
    if (text.length > 500) return;
    try {
      const { rows } = await pool.query(
        `INSERT INTO messages (room_id, user_id, text, created_at)
         VALUES ($1, $2, $3, NOW()) RETURNING *`,
        [roomId, user.uid, text.trim()]
      );
      const msg = {
        id: rows[0].id,
        room_id: roomId,
        user_id: user.uid,
        name: user.name,
        photo: user.photo,
        premium: user.premium,
        text: rows[0].text,
        created_at: rows[0].created_at
      };
      io.to("room_" + roomId).emit("new_message", msg);
    } catch (err) {
      console.error("Error guardando mensaje:", err.message);
      socket.emit("message_error", err.message);
    }
  });

  // ---- ENVIAR MENSAJE DM ----
  socket.on("send_dm", async ({ chatId, text }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !text || !text.trim()) return;
    const uids = chatId.split("_");
    if (!uids.includes(user.uid)) return;
    if (text.length > 500) return;
    try {
      const { rows } = await pool.query(
        `INSERT INTO dm_messages (chat_id, user_id, text, created_at)
         VALUES ($1, $2, $3, NOW()) RETURNING *`,
        [chatId, user.uid, text.trim()]
      );
      const msg = {
        id: rows[0].id,
        chat_id: chatId,
        user_id: user.uid,
        name: user.name,
        photo: user.photo,
        premium: user.premium,
        text: rows[0].text,
        created_at: rows[0].created_at
      };
      io.to("dm_" + chatId).emit("new_dm", msg);
    } catch (err) {
      socket.emit("message_error", err.message);
    }
  });

  // ---- DESCONEXIÓN ----
  socket.on("disconnect", () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      // Actualizar last_seen
      pool.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [user.uid]).catch(() => {});
      connectedUsers.delete(socket.id);
      console.log(`👋 ${user.name} desconectado`);
    }
  });
});

// ---- INICIAR SERVIDOR ----
server.listen(PORT, () => {
  console.log(`🚀 Therian backend corriendo en puerto ${PORT}`);
});

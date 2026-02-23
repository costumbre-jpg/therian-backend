// ============================================
// Therian Chat  Backend Server v2
// Node.js + Express + Socket.io + PostgreSQL
// Google Identity Services (sin Firebase)
// ============================================

const express     = require("express");
const http        = require("http");
const { Server }  = require("socket.io");
const cors        = require("cors");
const rateLimit   = require("express-rate-limit");
const { Pool }    = require("pg");
const jwt         = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const PORT             = process.env.PORT || 4000;
const FRONTEND_URL     = process.env.FRONTEND_URL || "https://therianworld.netlify.app";

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === FRONTEND_URL) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET env var is required. Server cannot start without it.");
  process.exit(1);
}
const JWT_SECRET       = process.env.JWT_SECRET;
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
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE`).catch(() => {});
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS desc_text TEXT DEFAULT ''`).catch(() => {});
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS theriotype TEXT DEFAULT ''`).catch(() => {});
  pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    msg_id TEXT,
    msg_text TEXT,
    reported_uid TEXT,
    reported_name TEXT,
    reporter_uid TEXT,
    room_id TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    resolved BOOLEAN DEFAULT FALSE
  )`).catch(() => {});
} else {
  console.warn("WARN: DATABASE_URL no configurada");
}

// ---- WORD FILTER ----
const BAD_WORDS = [
  // Hate speech / death threats
  "kill yourself","kys","go die","you should die","i hope you die","mátate","suicídate","espero que te mueras",
  // Slurs (EN)
  "faggot","nigger","nigga","retard","retarded",
  // Slurs (ES)
  "maricón","maricon","negro de mierda","puto imbécil",
  // Harassment
  "rape","pedophile","pedo","violación","violacion",
  // Extreme insults
  "go fuck yourself","fuck you","hijo de puta","hdp","me cago en tu madre"
];

function containsBadWord(text) {
  const lower = text.toLowerCase();
  return BAD_WORDS.some(w => lower.includes(w));
}

async function sendReportEmail(report) {
  try {
    await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_key: "9076b9a0-51a2-44af-8ee3-7ba4f9a2b7dd",
        subject: "\uD83D\uDEA8 Therians — Mensaje reportado",
        from_name: "Therians Moderacion",
        message:
          "Usuario reportado: " + (report.reported_name || report.reported_uid) + "\n" +
          "ID usuario: " + report.reported_uid + "\n" +
          "Sala: " + (report.room_id || "DM") + "\n" +
          "Mensaje: " + report.msg_text + "\n" +
          "Reportado por: " + report.reporter_uid
      })
    });
  } catch(e) { console.error("Email report error:", e.message); }
}

// ---- EXPRESS ----
const app    = express();
const server = http.createServer(app);
const corsConfig = {
  origin: function(origin, callback) {
    if (isAllowedOrigin(origin)) callback(null, true);
    else callback(new Error("CORS not allowed"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
};
const io     = new Server(server, { cors: corsConfig });

app.use(cors(corsConfig));
app.use(express.json({ limit: "5mb" }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});
app.use("/api/", apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many login attempts. Try again in 15 minutes." }
});

app.get("/", (req, res) => res.json({ status: "ok", app: "Therian Chat API v2" }));

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
app.post("/api/auth/google", authLimiter, async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: "idToken requerido" });
  try {
    const gUser = await verifyGoogleToken(idToken);
    const uid   = gUser.sub; // ID unico de Google

    const existing = await pool.query("SELECT id FROM users WHERE id = $1", [uid]);
    const isNewUser = existing.rows.length === 0;

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

    if (isNewUser) {
      io.to("room_general").emit("new_message", {
        id: "sys-" + Date.now(), room_id: "general", user_id: "system",
        name: "Therians", photo: "", premium: false, theriotype: "",
        text: "🐾 " + (user.name || "A new therian") + " just joined the pack! Welcome!",
        created_at: new Date().toISOString(), is_system: true
      });
    }

    const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user, is_new: isNewUser });
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
    user.desc = user.desc_text || "";
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ACTUALIZAR PERFIL (descripcion + theriotype) ----
app.patch("/api/users/me", authMiddleware, async (req, res) => {
  const { desc, theriotype } = req.body;
  if (desc !== undefined && typeof desc === "string" && desc.length > 200) {
    return res.status(400).json({ error: "Descripcion muy larga (max 200)" });
  }
  const validTheriotypes = ["", "wolf", "cat", "fox", "bird", "dragon", "bear", "deer", "other"];
  if (theriotype !== undefined && !validTheriotypes.includes(theriotype)) {
    return res.status(400).json({ error: "Theriotype invalido" });
  }
  try {
    const updates = [];
    const values = [];
    let idx = 1;
    if (desc !== undefined) { updates.push("desc_text = $" + idx); values.push(desc || ""); idx++; }
    if (theriotype !== undefined) { updates.push("theriotype = $" + idx); values.push(theriotype); idx++; }
    if (!updates.length) return res.status(400).json({ error: "No hay cambios" });
    values.push(req.uid);
    const { rows } = await pool.query(
      "UPDATE users SET " + updates.join(", ") + " WHERE id = $" + idx + " RETURNING *",
      values
    );
    if (!rows.length) return res.status(404).json({ error: "Usuario no encontrado" });
    const user = rows[0];
    user.desc = user.desc_text;
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
              u.name, u.photo, u.premium, u.theriotype
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
              u.name, u.photo, u.premium, u.theriotype
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
      `SELECT u.id, u.name, u.photo, u.premium, u.last_seen, u.theriotype
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
      "SELECT id, name, photo, last_seen, desc_text, theriotype FROM users WHERE id = $1", [req.params.uid]
    );
    if (!rows.length) return res.status(404).json({ error: "Usuario no encontrado" });
    const user = rows[0];
    user.desc = user.desc_text || "";
    res.json(user);
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

// ---- REPORTAR MENSAJE ----
app.post("/api/reports", authMiddleware, async (req, res) => {
  const { msgId, msgText, reportedUid, reportedName, roomId } = req.body;
  if (!reportedUid || !msgText) return res.status(400).json({ error: "Datos incompletos" });
  try {
    await pool.query(
      `INSERT INTO reports (msg_id, msg_text, reported_uid, reported_name, reporter_uid, room_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [msgId || null, msgText, reportedUid, reportedName || "", req.uid, roomId || ""]
    );
    await sendReportEmail({ msg_text: msgText, reported_uid: reportedUid, reported_name: reportedName, room_id: roomId, reporter_uid: req.uid });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- VER REPORTES (solo admin, con paginacion y filtro) ----
app.get("/api/admin/reports", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    const resolved = status === "resolved";

    const { rows } = await pool.query(
      `SELECT r.*, u.photo AS reported_photo
       FROM reports r LEFT JOIN users u ON u.id = r.reported_uid
       WHERE r.resolved = $1
       ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
      [resolved, limit, offset]
    );

    const countResult = await pool.query(
      "SELECT COUNT(*) FROM reports WHERE resolved = $1", [resolved]
    );
    const total = parseInt(countResult.rows[0].count);

    res.json({ reports: rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- CONTAR REPORTES PENDIENTES (solo admin) ----
app.get("/api/admin/reports/count", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT COUNT(*) FROM reports WHERE resolved = FALSE");
    res.json({ pending: parseInt(rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- RESOLVER/DESCARTAR REPORTE (solo admin) ----
app.patch("/api/admin/reports/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await pool.query("UPDATE reports SET resolved = TRUE WHERE id = $1", [req.params.id]);
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

// Lista de usuarios baneados
app.get("/api/admin/banned", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, photo, email FROM users WHERE is_banned = TRUE ORDER BY name"
    );
    res.json(rows);
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
        connectedUsers.set(socket.id, { uid: user.id, name: user.name, photo: user.photo, premium: user.premium, theriotype: user.theriotype || "" });
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
    if (containsBadWord(text.trim())) {
      socket.emit("message_blocked", "Tu mensaje fue bloqueado por contener contenido no permitido.");
      return;
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO messages (room_id, user_id, text, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *`,
        [roomId, user.uid, text.trim()]
      );
      io.to("room_" + roomId).emit("new_message", {
        id: rows[0].id, room_id: roomId, user_id: user.uid,
        name: user.name, photo: user.photo, premium: user.premium,
        theriotype: user.theriotype || "",
        text: rows[0].text, created_at: rows[0].created_at
      });
    } catch (err) { socket.emit("message_error", err.message); }
  });

  socket.on("send_dm", async ({ chatId, text }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !text || !text.trim() || text.length > 500) return;
    if (!chatId.split("_").includes(user.uid)) return;
    if (containsBadWord(text.trim())) {
      socket.emit("message_blocked", "Tu mensaje fue bloqueado por contener contenido no permitido.");
      return;
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO dm_messages (chat_id, user_id, text, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *`,
        [chatId, user.uid, text.trim()]
      );
      io.to("dm_" + chatId).emit("new_dm", {
        id: rows[0].id, chat_id: chatId, user_id: user.uid,
        name: user.name, photo: user.photo, premium: user.premium,
        theriotype: user.theriotype || "",
        text: rows[0].text, created_at: rows[0].created_at
      });
    } catch (err) { socket.emit("message_error", err.message); }
  });

  socket.on("typing", (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    if (data.chatId) socket.to("dm_" + data.chatId).emit("user_typing", { uid: user.uid, name: user.name });
    else if (data.roomId) socket.to("room_" + data.roomId).emit("user_typing", { uid: user.uid, name: user.name });
  });

  socket.on("stop_typing", (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    if (data.chatId) socket.to("dm_" + data.chatId).emit("user_stop_typing", { uid: user.uid });
    else if (data.roomId) socket.to("room_" + data.roomId).emit("user_stop_typing", { uid: user.uid });
  });

  socket.on("theriotype_set", (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !data.theriotype) return;
    const roomMap = { wolf: "wolves", cat: "cats", fox: "foxes", bird: "birds", dragon: "dragons", bear: "bears", deer: "deer" };
    const roomId = roomMap[data.theriotype];
    if (roomId) {
      io.to("room_" + roomId).emit("new_message", {
        id: "sys-" + Date.now(), room_id: roomId, user_id: "system",
        name: "Therians", photo: "", premium: false, theriotype: "",
        text: "🐾 " + user.name + " is a " + data.theriotype + " therian! Welcome to the den!",
        created_at: new Date().toISOString(), is_system: true
      });
    }
    user.theriotype = data.theriotype;
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

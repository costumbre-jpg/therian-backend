// ============================================
// Therian Chat  Backend Server v2
// Node.js + Express + Socket.io + PostgreSQL
// Google Identity Services (sin Firebase)
// ============================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const webpush = require("web-push");

const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://therianworld.netlify.app";

if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET env var is required. Server cannot start without it.");
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ADMIN_UID = process.env.ADMIN_UID || "";
const WEB3FORMS_KEY = process.env.WEB3FORMS_KEY || "";
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ---- VALID ROOMS (whitelist para todo QIURE) ----
const VALID_ROOMS = [
  // Therian World
  "general", "wolves", "cats", "foxes", "birds", "dragons", "bears", "deer", "vent",
  // Music World
  "music_pop", "music_rock", "music_latina", "music_jazz", "music_electronica", "music_clasica", "music_hiphop", "music_internacional",
  // Social World
  "social_facebook", "social_instagram", "social_tiktok", "social_twitter", "social_youtube", "social_linkedin", "social_emerging",
  // Prog World
  "prog_languages", "prog_web", "prog_mobile", "prog_databases", "prog_ai", "prog_devops", "prog_security",
  // Anime World
  "anime_shonen", "anime_shojo", "anime_seinen", "anime_isekai", "anime_mecha", "anime_sliceoflife", "anime_otaku"
];

// ---- POSTGRESQL ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "",
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

if (process.env.DATABASE_URL) {
  pool.query("SELECT 1").then(() => console.log("OK PostgreSQL"))
    .catch(err => console.error("ERROR PostgreSQL:", err.message));
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE`).catch(() => { });
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS desc_text TEXT DEFAULT ''`).catch(() => { });
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS theriotype TEXT DEFAULT ''`).catch(() => { });
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
  )`).catch(() => { });
  pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => { });
  pool.query(`CREATE TABLE IF NOT EXISTS friend_requests (
    id SERIAL PRIMARY KEY,
    from_uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_uid TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(from_uid, to_uid)
  )`).catch(() => { });
  pool.query(`ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ DEFAULT NULL`).catch(() => { });
  pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to INTEGER DEFAULT NULL`).catch(() => { });
  pool.query(`ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS reply_to INTEGER DEFAULT NULL`).catch(() => { });
} else {
  console.warn("WARN: DATABASE_URL not configured");
}

// ---- WORD FILTER ----
const BAD_WORDS = [
  // Hate speech / death threats
  "kill yourself", "kys", "go die", "you should die", "i hope you die", "mátate", "suicídate", "espero que te mueras",
  // Slurs (EN)
  "faggot", "nigger", "nigga", "retard", "retarded",
  // Slurs (ES)
  "maricón", "maricon", "negro de mierda", "puto imbécil",
  // Harassment
  "rape", "pedophile", "pedo", "violación", "violacion",
  // Extreme insults
  "go fuck yourself", "fuck you", "hijo de puta", "hdp", "me cago en tu madre"
];

function containsBadWord(text) {
  const lower = text.toLowerCase();
  return BAD_WORDS.some(w => lower.includes(w));
}

// ---- WEB3FORMS REPORT EMAIL ----
async function sendReportEmail(report) {
  if (!WEB3FORMS_KEY) return;
  try {
    await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_key: WEB3FORMS_KEY,
        subject: "\uD83D\uDEA8 Therians — Reported message",
        from_name: "Therians Moderation",
        message:
          "Reported user: " + (report.reported_name || report.reported_uid) + "\n" +
          "User ID: " + report.reported_uid + "\n" +
          "Room: " + (report.room_id || "DM") + "\n" +
          "Message: " + report.msg_text + "\n" +
          "Reported by: " + report.reporter_uid
      })
    });
  } catch (e) { console.error("Email report error:", e.message); }
}

// ---- VAPID KEYS (from env vars, not regenerated) ----
const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || "").trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || "").trim();
let vapidConfigured = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      "mailto:admin@therianworld.netlify.app",
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
    vapidConfigured = true;
    console.log("OK VAPID keys configured");
  } catch (err) {
    console.error("ERROR VAPID keys invalid (push disabled):", err.message);
    console.error("Make sure you copied the keys without extra spaces or quotes.");
  }
} else {
  console.warn("WARN: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY not configured. Push notifications disabled.");
}

// ---- PUSH NOTIFICATION HELPERS ----
async function sendPushToUser(recipientUid, title, body) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const { rows } = await pool.query(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1",
      [recipientUid]
    );
    if (!rows.length) return;
    const sub = {
      endpoint: rows[0].endpoint,
      keys: { p256dh: rows[0].p256dh, auth: rows[0].auth }
    };
    await webpush.sendNotification(sub, JSON.stringify({
      title: title,
      body: body,
      url: "/chat.html"
    }));
  } catch (err) {
    // If subscription expired, remove it
    if (err.statusCode === 410 || err.statusCode === 404) {
      await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1", [recipientUid]).catch(() => { });
    }
  }
}

async function sendPushToRoom(roomId, senderUid, body) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    // Collect UIDs of ALL currently-connected users (they get real-time via socket)
    const onlineUids = new Set();
    for (const [, u] of connectedUsers) {
      onlineUids.add(u.uid);
    }

    // Send push to every subscriber who is NOT currently online (offline users)
    // and also to online users who are in the room but have the tab hidden
    const { rows } = await pool.query(
      "SELECT user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id != $1",
      [senderUid]
    );
    for (const row of rows) {
      try {
        const sub = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth }
        };
        await webpush.sendNotification(sub, JSON.stringify({
          title: "New message in #" + roomId,
          body: body,
          url: "/chat.html"
        }));
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1", [row.user_id]).catch(() => { });
        }
      }
    }
  } catch (err) {
    console.error("sendPushToRoom error:", err.message);
  }
}

// ---- EXPRESS ----
const app = express();
const server = http.createServer(app);

// Support multiple frontend origins (comma-separated in FRONTEND_URL env)
const ALLOWED_ORIGINS = FRONTEND_URL.split(",").map(u => u.trim()).filter(Boolean);

const corsConfig = {
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS not allowed"));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
};
const io = new Server(server, { cors: corsConfig });

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

// ---- VERIFY GOOGLE TOKEN ----
async function verifyGoogleToken(idToken) {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID || undefined
  });
  const payload = ticket.getPayload();
  return payload;
}

// ---- MIDDLEWARE: verify JWT ----
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authorized" });
  }
  try {
    const decoded = jwt.verify(header.split(" ")[1], JWT_SECRET);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ---- MIDDLEWARE: admin only ----
function adminMiddleware(req, res, next) {
  if (!ADMIN_UID || req.uid !== ADMIN_UID) return res.status(403).json({ error: "Not authorized" });
  next();
}

// ============================================================
// ROUTES
// ============================================================

// ---- LOGIN WITH GOOGLE ----
app.post("/api/auth/google", authLimiter, async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: "idToken required" });
  try {
    const gUser = await verifyGoogleToken(idToken);
    const uid = gUser.sub;

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

    if (user.is_banned) return res.status(403).json({ error: "Your account has been banned from Therians." });

    if (isNewUser) {
      io.to("room_general").emit("new_message", {
        id: "sys-" + Date.now(), room_id: "general", user_id: "system",
        name: "Therians", photo: "", premium: false, theriotype: "",
        text: "🐾 " + (user.name || "A new therian") + " just joined the pack! Welcome!",
        sys_type: "welcome", sys_name: user.name || "A new therian",
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

// ---- PROFILE ----
app.get("/api/users/me", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.uid]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    const user = rows[0];
    user.is_admin = !!(ADMIN_UID && req.uid === ADMIN_UID);
    user.desc = user.desc_text || "";
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- UPDATE PROFILE (description + theriotype) ----
app.patch("/api/users/me", authMiddleware, async (req, res) => {
  const { desc, theriotype } = req.body;
  if (desc !== undefined && typeof desc === "string" && desc.length > 200) {
    return res.status(400).json({ error: "Description too long (max 200)" });
  }
  const validTheriotypes = ["", "wolf", "cat", "fox", "bird", "dragon", "bear", "deer", "other"];
  if (theriotype !== undefined && !validTheriotypes.includes(theriotype)) {
    return res.status(400).json({ error: "Invalid theriotype" });
  }
  try {
    const updates = [];
    const values = [];
    let idx = 1;
    if (desc !== undefined) { updates.push("desc_text = $" + idx); values.push(desc || ""); idx++; }
    if (theriotype !== undefined) { updates.push("theriotype = $" + idx); values.push(theriotype); idx++; }
    if (!updates.length) return res.status(400).json({ error: "No changes" });
    values.push(req.uid);
    const { rows } = await pool.query(
      "UPDATE users SET " + updates.join(", ") + " WHERE id = $" + idx + " RETURNING *",
      values
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    const user = rows[0];
    user.desc = user.desc_text;
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- UPDATE NAME ----
app.put("/api/users/me/name", authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name || name.length > 40) return res.status(400).json({ error: "Invalid name" });
  try {
    await pool.query("UPDATE users SET name = $1 WHERE id = $2", [name, req.uid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- UPDATE PHOTO (base64) ----
app.put("/api/users/me/photo", authMiddleware, async (req, res) => {
  const { photo } = req.body;
  if (!photo) return res.status(400).json({ error: "Photo required" });
  // Limit photo size to ~1MB (base64 is ~33% larger than raw bytes)
  if (photo.length > 1_400_000) return res.status(400).json({ error: "Photo too large (max ~1MB)" });
  try {
    await pool.query("UPDATE users SET photo = $1 WHERE id = $2", [photo, req.uid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ROOM MESSAGES ----
app.get("/api/rooms/:roomId/messages", authMiddleware, async (req, res) => {
  const roomId = req.params.roomId;
  if (!VALID_ROOMS.includes(roomId)) return res.status(400).json({ error: "Invalid room" });
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.room_id, m.user_id, m.text, m.created_at, m.reply_to,
              u.name, u.photo, u.premium, u.theriotype,
              rm.text AS reply_text, ru.name AS reply_name
       FROM messages m JOIN users u ON u.id = m.user_id
       LEFT JOIN messages rm ON rm.id = m.reply_to
       LEFT JOIN users ru ON ru.id = rm.user_id
       WHERE m.room_id = $1 ORDER BY m.created_at ASC LIMIT 500`,
      [roomId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- DM MESSAGES ----
app.get("/api/dms/:chatId/messages", authMiddleware, async (req, res) => {
  const chatId = req.params.chatId;
  const uids = chatId.split("_");
  if (uids.length !== 2 || !uids.includes(req.uid)) return res.status(403).json({ error: "Access denied" });
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.chat_id, m.user_id, m.text, m.created_at, m.read_at, m.reply_to,
              u.name, u.photo, u.premium, u.theriotype,
              rm.text AS reply_text, ru.name AS reply_name
       FROM dm_messages m JOIN users u ON u.id = m.user_id
       LEFT JOIN dm_messages rm ON rm.id = m.reply_to
       LEFT JOIN users ru ON ru.id = rm.user_id
       WHERE m.chat_id = $1 ORDER BY m.created_at ASC LIMIT 500`,
      [chatId]
    );

    // Mark messages as read automatically when history is fetched by recipient
    const result = await pool.query(
      `UPDATE dm_messages SET read_at = NOW()
       WHERE chat_id = $1 AND user_id != $2 AND read_at IS NULL`,
      [chatId, req.uid]
    );
    if (result.rowCount > 0) {
      const otherUid = uids[0] === req.uid ? uids[1] : uids[0];
      for (const [socketId, u] of connectedUsers.entries()) {
        if (u.uid === otherUid) {
          io.to(socketId).emit("dm_read", { chatId, readBy: req.uid });
        }
      }

      // Update read_at in the returned rows for consistency
      rows.forEach(r => {
        if (r.user_id !== req.uid && !r.read_at) r.read_at = new Date();
      });
    }

    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- FRIENDS ----
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

// ---- SEND FRIEND REQUEST ----
app.post("/api/friends/:uid", authMiddleware, async (req, res) => {
  const friendUid = req.params.uid;
  if (!friendUid || friendUid === req.uid) return res.status(400).json({ error: "Invalid ID" });
  try {
    const { rows: userRows } = await pool.query("SELECT id, name FROM users WHERE id = $1", [friendUid]);
    if (!userRows.length) return res.status(404).json({ error: "User not found" });
    // Check if already friends
    const { rows: existing } = await pool.query(
      "SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2", [req.uid, friendUid]
    );
    if (existing.length) return res.json({ ok: true, already: true });
    // Check if request already exists
    const { rows: existingReq } = await pool.query(
      "SELECT id, status FROM friend_requests WHERE from_uid = $1 AND to_uid = $2", [req.uid, friendUid]
    );
    if (existingReq.length) {
      if (existingReq[0].status === 'pending') return res.json({ ok: true, pending: true });
      // If rejected, allow re-sending
      await pool.query("UPDATE friend_requests SET status = 'pending', created_at = NOW() WHERE id = $1", [existingReq[0].id]);
    } else {
      // Check if THEY already sent US a request — auto-accept
      const { rows: reverseReq } = await pool.query(
        "SELECT id FROM friend_requests WHERE from_uid = $1 AND to_uid = $2 AND status = 'pending'", [friendUid, req.uid]
      );
      if (reverseReq.length) {
        // Auto-accept: they requested us, we requested them
        await pool.query("UPDATE friend_requests SET status = 'accepted' WHERE id = $1", [reverseReq[0].id]);
        await pool.query(
          `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.uid, friendUid]
        );
        await pool.query(
          `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [friendUid, req.uid]
        );
        // Notify both via socket
        const { rows: meRows } = await pool.query("SELECT name, photo FROM users WHERE id = $1", [req.uid]);
        for (const [socketId, u] of connectedUsers.entries()) {
          if (u.uid === friendUid) {
            io.to(socketId).emit("friend_accepted", { uid: req.uid, name: meRows[0]?.name || "Therian" });
          }
          if (u.uid === req.uid) {
            io.to(socketId).emit("friend_accepted", { uid: friendUid, name: userRows[0].name });
          }
        }
        return res.json({ ok: true, accepted: true });
      }
      await pool.query(
        `INSERT INTO friend_requests (from_uid, to_uid) VALUES ($1, $2)`, [req.uid, friendUid]
      );
    }
    // Get sender info for notification
    const { rows: senderRows } = await pool.query("SELECT name, photo FROM users WHERE id = $1", [req.uid]);
    const senderName = senderRows[0]?.name || "Someone";
    const senderPhoto = senderRows[0]?.photo || "";
    // Notify recipient via socket
    for (const [socketId, u] of connectedUsers.entries()) {
      if (u.uid === friendUid) {
        io.to(socketId).emit("friend_request", { from: req.uid, name: senderName, photo: senderPhoto });
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- GET PENDING FRIEND REQUESTS ----
app.get("/api/friend-requests", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT fr.id, fr.from_uid, fr.created_at, u.name, u.photo, u.theriotype
       FROM friend_requests fr JOIN users u ON u.id = fr.from_uid
       WHERE fr.to_uid = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [req.uid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ACCEPT FRIEND REQUEST ----
app.post("/api/friend-requests/:id/accept", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM friend_requests WHERE id = $1 AND to_uid = $2 AND status = 'pending'",
      [req.params.id, req.uid]
    );
    if (!rows.length) return res.status(404).json({ error: "Request not found" });
    const fr = rows[0];
    await pool.query("UPDATE friend_requests SET status = 'accepted' WHERE id = $1", [fr.id]);
    // Create friendship both ways
    await pool.query(
      `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.uid, fr.from_uid]
    );
    await pool.query(
      `INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [fr.from_uid, req.uid]
    );
    // Notify the sender via socket
    const { rows: meRows } = await pool.query("SELECT name, photo FROM users WHERE id = $1", [req.uid]);
    for (const [socketId, u] of connectedUsers.entries()) {
      if (u.uid === fr.from_uid) {
        io.to(socketId).emit("friend_accepted", { uid: req.uid, name: meRows[0]?.name || "Therian" });
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- REJECT FRIEND REQUEST ----
app.post("/api/friend-requests/:id/reject", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE friend_requests SET status = 'rejected' WHERE id = $1 AND to_uid = $2 AND status = 'pending'",
      [req.params.id, req.uid]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Request not found" });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- LOOKUP USER BY ID (requires auth) ----
app.get("/api/users/lookup/:uid", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, photo, last_seen, desc_text, theriotype FROM users WHERE id = $1", [req.params.uid]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    const user = rows[0];
    user.desc = user.desc_text || "";
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- PUSH NOTIFICATION ENDPOINTS ----
app.post("/api/push/subscribe", authMiddleware, async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: "Invalid subscription" });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET endpoint = $2, p256dh = $3, auth = $4, created_at = NOW()`,
      [req.uid, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/push/public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY, configured: vapidConfigured });
});

// ---- UNREAD DMS (for checking on login) ----
app.get("/api/dms/unread", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT chat_id, user_id AS from_uid
       FROM dm_messages
       WHERE chat_id LIKE $1 AND user_id != $2 AND read_at IS NULL
       UNION
       SELECT DISTINCT chat_id, user_id AS from_uid
       FROM dm_messages
       WHERE chat_id LIKE $3 AND user_id != $2 AND read_at IS NULL`,
      [req.uid + '_%', req.uid, '%_' + req.uid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- MARK DM MESSAGES AS READ ----
app.post("/api/dms/:chatId/read", authMiddleware, async (req, res) => {
  const chatId = req.params.chatId;
  const uids = chatId.split("_");
  if (uids.length !== 2 || !uids.includes(req.uid)) return res.status(403).json({ error: "Access denied" });
  try {
    const result = await pool.query(
      `UPDATE dm_messages SET read_at = NOW()
       WHERE chat_id = $1 AND user_id != $2 AND read_at IS NULL`,
      [chatId, req.uid]
    );
    // Notify the other user that their messages were read
    if (result.rowCount > 0) {
      const otherUid = uids[0] === req.uid ? uids[1] : uids[0];
      for (const [socketId, u] of connectedUsers.entries()) {
        if (u.uid === otherUid) {
          io.to(socketId).emit("dm_read", { chatId, readBy: req.uid });
        }
      }
    }
    res.json({ ok: true, count: result.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- CREATE REPORT ----
app.post("/api/reports", authMiddleware, async (req, res) => {
  const { msgId, msgText, reportedUid, reportedName, roomId } = req.body;
  if (!msgText && !reportedUid) return res.status(400).json({ error: "Invalid report data" });
  try {
    await pool.query(
      `INSERT INTO reports (msg_id, msg_text, reported_uid, reported_name, reporter_uid, room_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [msgId || null, msgText || "", reportedUid || "", reportedName || "", req.uid, roomId || ""]
    );
    // Send email notification to admin
    sendReportEmail({
      reported_name: reportedName,
      reported_uid: reportedUid,
      room_id: roomId,
      msg_text: msgText,
      reporter_uid: req.uid
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: GET REPORTS (paginated) ----
app.get("/api/admin/reports", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const status = req.query.status || "pending";
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
    const total = countResult.rows[0] ? parseInt(countResult.rows[0].count) : 0;

    res.json({ reports: rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: COUNT PENDING REPORTS ----
app.get("/api/admin/reports/count", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT COUNT(*) FROM reports WHERE resolved = FALSE");
    res.json({ pending: rows[0] ? parseInt(rows[0].count) : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: RESOLVE/DISMISS REPORT ----
app.patch("/api/admin/reports/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await pool.query("UPDATE reports SET resolved = TRUE WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ADMIN: BAN / UNBAN / DELETE MESSAGE
// ============================================================

app.post("/api/admin/ban/:uid", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await pool.query("UPDATE users SET is_banned = TRUE WHERE id = $1", [req.params.uid]);
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

app.get("/api/admin/banned", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, photo, email FROM users WHERE is_banned = TRUE ORDER BY name"
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/unban/:uid", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await pool.query("UPDATE users SET is_banned = FALSE WHERE id = $1", [req.params.uid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/admin/messages/:msgId", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("DELETE FROM messages WHERE id = $1 RETURNING room_id", [req.params.msgId]);
    if (rows.length) io.to("room_" + rows[0].room_id).emit("message_deleted", req.params.msgId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/messages/:msgId", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("DELETE FROM messages WHERE id = $1 AND user_id = $2 RETURNING room_id", [req.params.msgId, req.uid]);
    if (rows.length) {
      io.to("room_" + rows[0].room_id).emit("message_deleted", req.params.msgId);
      return res.json({ ok: true });
    }
    const dm = await pool.query("DELETE FROM dm_messages WHERE id = $1 AND user_id = $2 RETURNING chat_id", [req.params.msgId, req.uid]);
    if (dm.rows.length) {
      io.to("dm_" + dm.rows[0].chat_id).emit("message_deleted", req.params.msgId);
      return res.json({ ok: true });
    }
    res.status(404).json({ error: "Message not found" });
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
        if (!rows.length) return socket.emit("auth_error", "User not found");
        const user = rows[0];
        if (user.is_banned) return socket.emit("banned");
        connectedUsers.set(socket.id, { uid: user.id, name: user.name, photo: user.photo, premium: user.premium, theriotype: user.theriotype || "" });
        socket.emit("auth_ok");
        pool.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [user.id]).catch(() => { });

        // Send initial online users to this socket
        const onlineUids = Array.from(new Set(Array.from(connectedUsers.values()).map(u => u.uid)));
        socket.emit("online_users", onlineUids);

        // Tell others this user is online
        socket.broadcast.emit("user_online", user.id);
      });
    } catch (err) {
      socket.emit("auth_error", "Invalid token");
    }
  });

  socket.on("disconnect", () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      connectedUsers.delete(socket.id);
      pool.query("UPDATE users SET last_seen = NOW() WHERE id = $1", [user.uid]).catch(() => { });
      const stillOnline = Array.from(connectedUsers.values()).some(u => u.uid === user.uid);
      if (!stillOnline) {
        io.emit("user_offline", user.uid);
      }
    }
  });

  socket.on("join_room", (roomId) => {
    if (!connectedUsers.has(socket.id) || !roomId || typeof roomId !== "string") return;
    if (!VALID_ROOMS.includes(roomId)) return;
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join("room_" + roomId);
  });

  socket.on("join_dm", (chatId) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !chatId || typeof chatId !== "string") return;
    const dmParts = chatId.split("_");
    if (dmParts.length !== 2 || !dmParts.includes(user.uid)) return;
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join("dm_" + chatId);
  });

  socket.on("send_message", async ({ roomId, text, replyTo }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !roomId || typeof roomId !== "string" || !text || !text.trim() || text.length > 500) return;
    if (!VALID_ROOMS.includes(roomId)) return;
    if (containsBadWord(text.trim())) {
      socket.emit("message_blocked", "Your message was blocked for containing prohibited content.");
      return;
    }
    try {
      const replyId = replyTo && Number.isInteger(Number(replyTo)) ? Number(replyTo) : null;
      const { rows } = await pool.query(
        `INSERT INTO messages (room_id, user_id, text, reply_to, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
        [roomId, user.uid, text.trim(), replyId]
      );
      let replyData = null;
      if (replyId) {
        const rr = await pool.query(`SELECT m.id, m.text, u.name FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1`, [replyId]);
        if (rr.rows.length) replyData = { id: rr.rows[0].id, text: rr.rows[0].text, name: rr.rows[0].name };
      }
      io.to("room_" + roomId).emit("new_message", {
        id: rows[0].id, room_id: roomId, user_id: user.uid,
        name: user.name, photo: user.photo, premium: user.premium,
        theriotype: user.theriotype || "",
        text: rows[0].text, created_at: rows[0].created_at,
        reply_to: replyId, reply: replyData
      });
      sendPushToRoom(roomId, user.uid, `${user.name}: ${rows[0].text}`);
    } catch (err) { socket.emit("message_error", err.message); }
  });

  socket.on("send_dm", async ({ chatId, text, replyTo }) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !chatId || typeof chatId !== "string" || !text || !text.trim() || text.length > 500) return;
    const dmUids = chatId.split("_");
    if (dmUids.length !== 2 || !dmUids.includes(user.uid)) return;
    if (containsBadWord(text.trim())) {
      socket.emit("message_blocked", "Your message was blocked for containing prohibited content.");
      return;
    }
    try {
      const replyId = replyTo && Number.isInteger(Number(replyTo)) ? Number(replyTo) : null;
      const { rows } = await pool.query(
        `INSERT INTO dm_messages (chat_id, user_id, text, reply_to, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
        [chatId, user.uid, text.trim(), replyId]
      );
      let replyData = null;
      if (replyId) {
        const rr = await pool.query(`SELECT m.id, m.text, u.name FROM dm_messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1`, [replyId]);
        if (rr.rows.length) replyData = { id: rr.rows[0].id, text: rr.rows[0].text, name: rr.rows[0].name };
      }
      const dmMsg = {
        id: rows[0].id, chat_id: chatId, user_id: user.uid,
        name: user.name, photo: user.photo, premium: user.premium,
        theriotype: user.theriotype || "",
        text: rows[0].text, created_at: rows[0].created_at,
        reply_to: replyId, reply: replyData
      };
      io.to("dm_" + chatId).emit("new_dm", dmMsg);
      // Push notification + socket notify to recipient
      const recipientUid = dmUids[0] === user.uid ? dmUids[1] : dmUids[0];
      sendPushToUser(recipientUid, user.name, rows[0].text);
      // Emit dm_notify to recipient's socket(s) for in-app toast
      for (const [socketId, u] of connectedUsers.entries()) {
        if (u.uid === recipientUid) {
          io.to(socketId).emit("dm_notify", {
            from: user.name,
            text: rows[0].text,
            chatId
          });
        }
      }
    } catch (err) { socket.emit("message_error", err.message); }
  });

  socket.on("typing", (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !data) return;
    if (data.chatId) socket.to("dm_" + data.chatId).emit("user_typing", { uid: user.uid, name: user.name });
    else if (data.roomId) socket.to("room_" + data.roomId).emit("user_typing", { uid: user.uid, name: user.name });
  });

  socket.on("stop_typing", (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !data) return;
    if (data.chatId) socket.to("dm_" + data.chatId).emit("user_stop_typing", { uid: user.uid });
    else if (data.roomId) socket.to("room_" + data.roomId).emit("user_stop_typing", { uid: user.uid });
  });

  socket.on("theriotype_set", (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !data || !data.theriotype) return;
    const roomMap = { wolf: "wolves", cat: "cats", fox: "foxes", bird: "birds", dragon: "dragons", bear: "bears", deer: "deer" };
    const roomId = roomMap[data.theriotype];
    if (roomId) {
      io.to("room_" + roomId).emit("new_message", {
        id: "sys-" + Date.now(), room_id: roomId, user_id: "system",
        name: "Therians", photo: "", premium: false, theriotype: "",
        text: "🐾 " + user.name + " is a " + data.theriotype + " therian! Welcome to the den!",
        sys_type: "theriotype", sys_name: user.name, sys_theriotype: data.theriotype,
        created_at: new Date().toISOString(), is_system: true
      });
    }
    user.theriotype = data.theriotype;
  });
});

server.listen(PORT, () => console.log("Therian backend running on port " + PORT));

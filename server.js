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
  // XP + Levels system columns
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0`).catch(() => { });
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 0`).catch(() => { });
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_streak INTEGER DEFAULT 0`).catch(() => { });
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_date DATE DEFAULT NULL`).catch(() => { });
  // Smart moderation: toxicity score
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS toxicity_score INTEGER DEFAULT 0`).catch(() => { });
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ DEFAULT NULL`).catch(() => { });
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
  // Daily missions table (auto-create)
  pool.query(`CREATE TABLE IF NOT EXISTS user_mission_progress (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mission_key TEXT NOT NULL,
    date_id TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    completed BOOLEAN DEFAULT false,
    PRIMARY KEY (user_id, mission_key, date_id)
  )`).catch(() => { });
  // XP daily cap tracking column
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp_earned_today INTEGER DEFAULT 0`).catch(() => { });
  pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp_today_date DATE DEFAULT NULL`).catch(() => { });
} else {
  console.warn("WARN: DATABASE_URL not configured");
}

// ============================================
// SMART MODERATION SYSTEM
// ============================================
const BAD_WORDS = [
  // Hate speech / death threats
  "kill yourself", "kys", "go die", "you should die", "i hope you die", "matate", "suicidate", "espero que te mueras",
  // Slurs (EN)
  "faggot", "nigger", "nigga", "retard", "retarded",
  // Slurs (ES)
  "maricon", "negro de mierda", "puto imbecil",
  // Harassment
  "rape", "pedophile", "pedo", "violacion",
  // Extreme insults
  "go fuck yourself", "fuck you", "hijo de puta", "hdp", "me cago en tu madre"
];

// Leetspeak normalization map
const LEET_MAP = { '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '$': 's', '5': 's', '7': 't', '+': 't', '¡': 'i' };

function normalizeLeet(text) {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += LEET_MAP[text[i]] || text[i];
  }
  return result;
}

function removeSpaceTricks(text) {
  // Remove dots, dashes, underscores, extra spaces between single chars: "f u c k" → "fuck"
  return text.replace(/([a-zA-Z])\s*[.\-_]*\s*(?=[a-zA-Z])/g, '$1');
}

// In-memory flood + repetition tracking
const _userMsgTimestamps = new Map(); // uid → [timestamp, ...]
const _userLastMessages = new Map();  // uid → [text, text, text]

function checkModeration(text, uid) {
  const now = Date.now();
  const trimmed = text.trim();

  // 1. Flood detection: >5 messages in 10 seconds
  const timestamps = _userMsgTimestamps.get(uid) || [];
  const recent = timestamps.filter(t => now - t < 10000);
  recent.push(now);
  _userMsgTimestamps.set(uid, recent.slice(-10)); // keep last 10
  if (recent.length > 5) {
    return { blocked: true, reason: "⚠️ Slow down! You're sending messages too fast." };
  }

  // 2. Repetitive message detection: same text 3 times in a row
  const lastMsgs = _userLastMessages.get(uid) || [];
  lastMsgs.push(trimmed.toLowerCase());
  if (lastMsgs.length > 3) lastMsgs.shift();
  _userLastMessages.set(uid, lastMsgs);
  if (lastMsgs.length >= 3 && lastMsgs.every(m => m === lastMsgs[0])) {
    return { blocked: true, reason: "⚠️ Please don't repeat the same message." };
  }

  // 3. Bad word check with leetspeak + space normalization
  const lower = trimmed.toLowerCase();
  const normalized = normalizeLeet(lower);
  const noSpaces = removeSpaceTricks(normalized);

  const textsToCheck = [lower, normalized, noSpaces];
  for (const t of textsToCheck) {
    if (BAD_WORDS.some(w => t.includes(w))) {
      return { blocked: true, reason: "Your message was blocked for containing prohibited content." };
    }
  }

  return { blocked: false };
}

// Increment toxicity score in DB
async function _incrementToxicity(uid) {
  try {
    const result = await pool.query(
      `UPDATE users SET toxicity_score = COALESCE(toxicity_score, 0) + 1 WHERE id = $1 RETURNING toxicity_score`,
      [uid]
    );
    const score = result.rows[0]?.toxicity_score || 0;
    if (score >= 10 && score < 20) {
      // Auto-mute for 1 hour
      await pool.query(`UPDATE users SET muted_until = NOW() + INTERVAL '1 hour' WHERE id = $1`, [uid]);
      console.log(`[moderation] User ${uid} auto-muted for 1 hour (toxicity: ${score})`);
    } else if (score >= 20) {
      console.log(`[moderation] User ${uid} flagged for admin review (toxicity: ${score})`);
    }
  } catch (e) { console.error('[moderation] toxicity update error:', e.message); }
}

// Check if user is muted
async function _isUserMuted(uid) {
  try {
    const { rows } = await pool.query(
      `SELECT muted_until FROM users WHERE id = $1 AND muted_until > NOW()`, [uid]
    );
    return rows.length > 0;
  } catch (e) { return false; }
}

// ============================================
// XP + LEVELS SYSTEM
// ============================================
function calculateLevel(xp) {
  return Math.floor(Math.sqrt((xp || 0) / 50));
}

function xpForLevel(level) {
  return level * level * 50;
}

const DAILY_XP_CAP = 200; // Max XP from messages per day

async function _awardXP(uid, amount, socketId, isMessageXP) {
  try {
    // Daily XP cap for message-based XP
    if (isMessageXP) {
      const today = new Date().toISOString().slice(0, 10);
      const { rows: capRows } = await pool.query(
        `SELECT xp_earned_today, xp_today_date FROM users WHERE id = $1`, [uid]
      );
      if (capRows.length) {
        const userDate = capRows[0].xp_today_date ? new Date(capRows[0].xp_today_date).toISOString().slice(0, 10) : null;
        let earnedToday = (userDate === today) ? (capRows[0].xp_earned_today || 0) : 0;
        if (earnedToday >= DAILY_XP_CAP) return; // Already hit daily cap
        amount = Math.min(amount, DAILY_XP_CAP - earnedToday); // Don't exceed cap
        if (amount <= 0) return;
        await pool.query(
          `UPDATE users SET xp_earned_today = $1, xp_today_date = CURRENT_DATE WHERE id = $2`,
          [earnedToday + amount, uid]
        );
      }
    }

    const { rows } = await pool.query(
      `UPDATE users SET xp = COALESCE(xp, 0) + $1 WHERE id = $2 RETURNING xp, level`,
      [amount, uid]
    );
    if (!rows.length) return;
    const newXP = rows[0].xp;
    const newLevel = calculateLevel(newXP);
    const oldLevel = rows[0].level || 0;

    // Update level if changed
    if (newLevel !== oldLevel) {
      await pool.query(`UPDATE users SET level = $1 WHERE id = $2`, [newLevel, uid]);
    }

    // Emit XP update to user's socket(s)
    for (const [sid, u] of connectedUsers.entries()) {
      if (u.uid === uid) {
        io.to(sid).emit('xp_update', {
          xp: newXP,
          level: newLevel,
          gained: amount,
          levelUp: newLevel > oldLevel ? newLevel : null,
          nextLevelXP: xpForLevel(newLevel + 1),
          progress: Math.round(((newXP - xpForLevel(newLevel)) / (xpForLevel(newLevel + 1) - xpForLevel(newLevel))) * 100)
        });
      }
    }
  } catch (e) { console.error('[xp] error:', e.message); }
}

// ============================================
// ROOM ACTIVITY TRACKER (Radar Social)
// ============================================
const _roomActivity = new Map(); // roomId → { timestamps: [ts,...], lastMsg: ts }

function _trackRoomMessage(roomId) {
  const now = Date.now();
  if (!_roomActivity.has(roomId)) {
    _roomActivity.set(roomId, { timestamps: [], lastMsg: now });
  }
  const data = _roomActivity.get(roomId);
  data.timestamps.push(now);
  data.lastMsg = now;
  // Keep only last 5 minutes of timestamps
  const fiveMinAgo = now - 300000;
  data.timestamps = data.timestamps.filter(t => t > fiveMinAgo);
}

function _getRoomActivityStats() {
  const now = Date.now();
  const fiveMinAgo = now - 300000;
  const stats = {};
  for (const roomId of VALID_ROOMS) {
    const data = _roomActivity.get(roomId);
    if (data) {
      const recentMsgs = data.timestamps.filter(t => t > fiveMinAgo).length;
      stats[roomId] = {
        msgs_5min: recentMsgs,
        is_hot: recentMsgs >= 3,
        last_msg_ago: Math.round((now - data.lastMsg) / 1000) // seconds ago
      };
    } else {
      stats[roomId] = { msgs_5min: 0, is_hot: false, last_msg_ago: -1 };
    }
  }
  // Add online count per room from socket rooms
  try {
    for (const roomId of VALID_ROOMS) {
      const room = io.sockets.adapter.rooms.get('room_' + roomId);
      stats[roomId].online = room ? room.size : 0;
    }
  } catch (e) { }
  return stats;
}

// ============================================
// ICEBREAKER BOT
// ============================================
const ICEBREAKER_QUESTIONS = {
  // Therian world
  general: [
    "🐾 If you could be any animal for a day, what would you choose?",
    "🌙 What's your favorite thing about being part of the therian community?",
    "🐺 What's the most interesting thing you've learned about your theriotype?",
    "🌿 Do you feel more connected to nature or the city? Why?",
    "🦊 If your theriotype could talk, what would they say right now?",
    "🎭 How did you first discover you were a therian?",
    "🌟 What superpower would your theriotype have?"
  ],
  wolves: ["🐺 What's your favorite wolf fact?", "🐺 Lone wolf or pack wolf? Why?", "🐺 Favorite wolf species?"],
  cats: ["🐱 Indoor or outdoor cat vibes?", "🐱 Big cats or small cats?", "🐱 What's the most cat thing you've done today?"],
  foxes: ["🦊 What's your fox spirit energy today?", "🦊 Arctic fox or red fox?", "🦊 Foxes are clever — what's your best life hack?"],
  birds: ["🐦 If you could fly anywhere right now, where?", "🐦 Favorite bird song?", "🐦 Dawn chorus or sunset flight?"],
  dragons: ["🐉 Fire, ice, or storm dragon?", "🐉 What would your dragon hoard be?", "🐉 If you had wings, where would you fly first?"],
  bears: ["🐻 Hibernate or adventure?", "🐻 Favorite season and why?", "🐻 Honey or fish? 😄"],
  deer: ["🦌 Forest or meadow?", "🦌 What makes you feel at peace?", "🦌 Spring vibes — what are you grateful for today?"],
  vent: ["💭 How are you feeling today? No judgment here.", "💭 What's one thing you'd like to get off your chest?", "💭 Remember: it's okay to not be okay. We're here for you."],

  // Music world
  music_pop: ["🎤 What song is stuck in your head right now?", "🎤 If you could attend any concert, past or present?", "🎤 Guilty pleasure song?"],
  music_rock: ["🎸 Classic rock or modern rock?", "🎸 Best guitar solo ever?", "🎸 Favorite rock band of all time?"],
  music_latina: ["💃 Reggaeton, salsa, or bachata?", "💃 Favorite Latino artist?", "💃 What song makes you dance every time?"],
  music_jazz: ["🎷 Smooth jazz or bebop?", "🎷 Favorite jazz instrument?", "🎷 Miles Davis or John Coltrane?"],
  music_electronica: ["🎧 Favorite DJ or producer?", "🎧 Festival you'd love to attend?", "🎧 Best drop you've ever heard?"],
  music_clasica: ["🎻 Beethoven or Mozart?", "🎻 Favorite symphony?", "🎻 Do you play any classical instrument?"],
  music_hiphop: ["🎤 Old school or new school hip-hop?", "🎤 Favorite rapper alive?", "🎤 Best hip-hop album ever?"],
  music_internacional: ["🌍 What's the best music from your country?", "🌍 Favorite non-English song?", "🌍 Music connects the world — what song proves it?"],

  // Anime world
  anime_shonen: ["⚔️ Naruto, One Piece, or Dragon Ball?", "⚔️ Best shonen fight scene ever?", "⚔️ Who's the strongest anime character?"],
  anime_shojo: ["🌸 Favorite romance anime?", "🌸 Best anime couple?", "🌸 Fruits Basket or Ouran?"],
  anime_seinen: ["🌑 Attack on Titan or Vinland Saga?", "🌑 Darkest anime you've watched?", "🌑 Manga or anime — which is better?"],
  anime_isekai: ["✨ If you were isekai'd, what power would you want?", "✨ Best isekai world to live in?", "✨ Sword Art Online or Re:Zero?"],
  anime_mecha: ["🤖 Gundam or Evangelion?", "🤖 Coolest mecha design ever?", "🤖 Would you pilot a giant robot?"],
  anime_sliceoflife: ["☕ Favorite cozy anime?", "☕ What anime world would you live in?", "☕ Best anime food scene?"],
  anime_otaku: ["🎌 How many anime have you watched?", "🎌 Favorite anime opening?", "🎌 Sub or dub?"],

  // Social world
  social_facebook: ["📘 Is Facebook still relevant? Why or why not?", "📘 Best Facebook memory?", "📘 Groups or pages — which is better?"],
  social_instagram: ["📸 Reels or stories?", "📸 How do you curate your feed?", "📸 Favorite type of content to post?"],
  social_tiktok: ["🎵 Favorite TikTok trend?", "🎵 Has TikTok changed how you consume content?", "🎵 FYP algorithm — blessing or curse?"],
  social_twitter: ["🐦 X or Twitter? What do you call it?", "🐦 Best tweet you've ever seen?", "🐦 Threads vs tweets?"],
  social_youtube: ["▶️ Favorite YouTuber?", "▶️ Shorts or long-form content?", "▶️ What's in your Watch Later?"],
  social_linkedin: ["💼 Real networking or just a show?", "💼 Best career advice you've received?", "💼 Do you actually use LinkedIn?"],
  social_emerging: ["✨ What's the next big social platform?", "✨ Decentralized social media — future or fad?", "✨ What feature do you wish existed?"],

  // Prog world
  prog_languages: ["💻 Favorite programming language and why?", "💻 Tabs or spaces?", "💻 What language are you learning next?"],
  prog_web: ["🌐 React, Vue, or Angular?", "🌐 Frontend or backend?", "🌐 Best website you've seen recently?"],
  prog_mobile: ["📱 iOS or Android development?", "📱 Native or cross-platform?", "📱 What app idea do you have?"],
  prog_databases: ["🗄️ SQL or NoSQL?", "🗄️ Favorite database?", "🗄️ Have you ever lost data? Tell the story."],
  prog_ai: ["🤖 Is AI going to replace programmers?", "🤖 Coolest AI project you've seen?", "🤖 ChatGPT, Claude, or Gemini?"],
  prog_devops: ["⚙️ Docker or Kubernetes?", "⚙️ CI/CD pipeline tips?", "⚙️ Worst deployment disaster?"],
  prog_security: ["🔐 Have you ever been hacked?", "🔐 Best security practice?", "🔐 Ethical hacking — have you tried it?"]
};

const _roomLastActivity = new Map(); // roomId → timestamp

function _startIcebreakerTimer() {
  setInterval(() => {
    const now = Date.now();
    const IDLE_THRESHOLD = 15 * 60 * 1000; // 15 minutes

    for (const roomId of VALID_ROOMS) {
      const lastActivity = _roomLastActivity.get(roomId) || 0;
      if (now - lastActivity < IDLE_THRESHOLD) continue;

      // Check if at least 2 people are in this room (icebreaker needs an audience)
      const room = io.sockets.adapter.rooms.get('room_' + roomId);
      if (!room || room.size < 2) continue;

      // Pick a random question for this room
      const questions = ICEBREAKER_QUESTIONS[roomId] || ICEBREAKER_QUESTIONS.general;
      const question = questions[Math.floor(Math.random() * questions.length)];

      // Send as system message (NOT saved to DB — ephemeral)
      io.to('room_' + roomId).emit('new_message', {
        id: 'icebreaker-' + Date.now(),
        room_id: roomId,
        user_id: 'system',
        name: 'QIURE Bot',
        photo: '',
        premium: false,
        theriotype: '',
        text: question,
        created_at: new Date().toISOString(),
        is_system: true,
        sys_type: 'icebreaker'
      });

      // Mark this room as having received an icebreaker
      _roomLastActivity.set(roomId, now);
      console.log(`[icebreaker] Sent to room ${roomId}: ${question}`);
    }
  }, 5 * 60 * 1000); // Check every 5 minutes
}

// Start the room activity broadcast (every 30 seconds)
function _startActivityBroadcast() {
  setInterval(() => {
    const stats = _getRoomActivityStats();
    // Only broadcast if there are connected users
    if (connectedUsers.size > 0) {
      io.emit('room_activity', stats);
    }
  }, 30000);
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

// ---- VAPID KEYS ----
// Generated specifically for QIURE push notifications
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "M0Rpy1yx68S7IOSV_GkOwOQuTxmxP8BCQzyRo2aWBJE8hZc0wjYNTdQ6eeKFREMcmJ9X-ANGOpOjf8FRrp11umAM";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "rHNzW0Nc0F3e_eqVcI6Ir9IAyLrfVvLo2CdFgSl-jZc";
let vapidConfigured = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      "mailto:admin@qiure.com",
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
    vapidConfigured = true;
    console.log("OK VAPID keys configured");
  } catch (err) {
    console.error("ERROR VAPID keys invalid (push disabled):", err.message);
  }
} else {
  console.warn("WARN: VAPID keys missing. Push disabled.");
}

// ---- PUSH NOTIFICATION HELPERS ----
async function sendPushToUser(recipientUid, title, body) {
  if (!vapidConfigured) { console.log('Push: VAPID not configured, skipping'); return; }
  try {
    const { rows } = await pool.query(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1",
      [recipientUid]
    );
    if (!rows.length) { console.log('Push: no subscription found for user', recipientUid); return; }
    console.log('Push: sending to user', recipientUid, 'endpoint:', rows[0].endpoint.substring(0, 60) + '...');
    const sub = {
      endpoint: rows[0].endpoint,
      keys: { p256dh: rows[0].p256dh, auth: rows[0].auth }
    };
    await webpush.sendNotification(sub, JSON.stringify({
      title: title,
      body: body,
      url: "/chat.html"
    }));
    console.log('Push: sent OK to user', recipientUid);
  } catch (err) {
    console.error('Push: sendPushToUser error:', err.statusCode, err.message);
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.log('Push: removing expired subscription for user', recipientUid);
      await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1", [recipientUid]).catch(() => { });
    }
  }
}

// Track which rooms each user has joined (for scoped push notifications)
const _userRoomMap = new Map(); // uid → roomId

async function sendPushToRoom(roomId, senderUid, body) {
  if (!vapidConfigured) return;
  try {
    // Collect UIDs of users who are currently in THIS room
    const roomMemberUids = new Set();
    const socketRoom = io.sockets.adapter.rooms.get('room_' + roomId);
    if (socketRoom) {
      for (const sid of socketRoom) {
        const user = connectedUsers.get(sid);
        if (user) roomMemberUids.add(user.uid);
      }
    }

    // Also include offline users who last visited this room (via _userRoomMap)
    for (const [uid, lastRoom] of _userRoomMap.entries()) {
      if (lastRoom === roomId) roomMemberUids.add(uid);
    }

    // Only send push to users who are in this room AND not the sender
    if (roomMemberUids.size === 0) return;
    const uidList = Array.from(roomMemberUids).filter(uid => uid !== senderUid);
    if (uidList.length === 0) return;

    // Batch query for subscriptions of relevant users only
    const { rows } = await pool.query(
      `SELECT user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1)`,
      [uidList]
    );
    console.log('Push room: found', rows.length, 'subscription(s) for room', roomId, '(relevant users only)');
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
const io = new Server(server, {
  cors: corsConfig,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["polling", "websocket"],
  allowUpgrades: true
});

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

// ---- DIAGNOSTIC ENDPOINT (no auth required) ----
app.get("/api/health", async (req, res) => {
  try {
    const dbCheck = await pool.query("SELECT NOW() as time");
    const msgCount = await pool.query("SELECT room_id, COUNT(*) as count FROM messages GROUP BY room_id ORDER BY count DESC LIMIT 20");
    const dmCount = await pool.query("SELECT COUNT(*) as count FROM dm_messages");
    const userCount = await pool.query("SELECT COUNT(*) as count FROM users");
    res.json({
      status: "ok",
      db_time: dbCheck.rows[0].time,
      users: userCount.rows[0].count,
      dm_messages: dmCount.rows[0].count,
      room_messages: msgCount.rows,
      connected_sockets: connectedUsers.size,
      allowed_origins: ALLOWED_ORIGINS
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

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

// ---- PUSH SUBSCRIBE ENDPOINT ----
app.post("/api/push/subscribe", authMiddleware, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: "Invalid subscription object" });
    }
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (user_id) DO UPDATE SET endpoint = $2, p256dh = $3, auth = $4`,
      [req.uid, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Push subscribe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

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
      // Push notification to all subscribers: new user joined QIURE
      (async () => {
        try {
          const { rows: allSubs } = await pool.query("SELECT user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id != $1", [uid]);
          for (const row of allSubs) {
            try {
              await webpush.sendNotification(
                { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
                JSON.stringify({ title: "Nuevo en QIURE", body: (user.name || "Alguien") + " se unió a QIURE. ¡Dale la bienvenida!", url: "/" })
              );
            } catch (e) {
              if (e.statusCode === 410 || e.statusCode === 404) {
                await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1", [row.user_id]).catch(() => { });
              }
            }
          }
        } catch (e) { console.error("Push new user error:", e.message); }
      })();
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
    user.xp = user.xp || 0;
    user.level = calculateLevel(user.xp);
    // Daily login XP + streak
    const today = new Date().toISOString().slice(0, 10);
    const lastLogin = user.last_login_date ? new Date(user.last_login_date).toISOString().slice(0, 10) : null;
    if (lastLogin !== today) {
      let streak = user.login_streak || 0;
      if (lastLogin) {
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        streak = (lastLogin === yesterday) ? streak + 1 : 1;
      } else {
        streak = 1;
      }
      const dailyXP = 10 + (Math.min(streak, 7) * 5); // 10 base + up to 35 streak bonus
      await pool.query(
        `UPDATE users SET last_login_date = CURRENT_DATE, login_streak = $1 WHERE id = $2`,
        [streak, req.uid]
      );
      _awardXP(req.uid, dailyXP, null);
      user.login_streak = streak;
      user.daily_xp_awarded = dailyXP;
    }
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- UPDATE PROFILE (description + theriotype) ----
app.patch("/api/users/me", authMiddleware, async (req, res) => {
  const { desc, theriotype } = req.body;
  if (desc !== undefined && typeof desc === "string" && desc.length > 200) {
    return res.status(400).json({ error: "Description too long (max 200)" });
  }
  const validTheriotypes = [
    "",
    // Therian
    "wolf", "cat", "fox", "bird", "dragon", "bear", "deer", "other",
    // Social Media
    "facebook", "instagram", "tiktok", "twitter", "youtube", "linkedin",
    // Programming
    "languages", "web", "mobile", "databases", "ai", "devops", "security",
    // Music
    "pop", "rock", "latina", "jazz", "electronica", "clasica", "hiphop", "internacional",
    // Anime
    "shonen", "shojo", "seinen", "isekai", "mecha", "sliceoflife", "otaku"
  ];
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
       WHERE m.room_id = $1 ORDER BY m.created_at DESC LIMIT 3000`,
      [roomId]
    );
    rows.reverse(); // So frontend receives them in chronological order
    console.log(`[messages] room=${roomId} uid=${req.uid} rows=${rows.length}`);
    res.json(rows);
  } catch (err) {
    console.error(`[messages] ERROR room=${roomId} uid=${req.uid}:`, err.message);
    res.status(500).json({ error: err.message });
  }
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
       WHERE m.chat_id = $1 ORDER BY m.created_at DESC LIMIT 3000`,
      [chatId]
    );
    rows.reverse();

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
    // Push notification for friend request
    sendPushToUser(friendUid, "Nueva solicitud de amistad", senderName + " te envió una solicitud de amistad");
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
    // Award XP to both users for becoming friends
    _awardXP(req.uid, 10, null);
    _awardXP(fr.from_uid, 10, null);
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
  console.log('Push subscribe: user', req.uid, 'endpoint:', sub && sub.endpoint ? sub.endpoint.substring(0, 60) + '...' : 'MISSING');
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    console.log('Push subscribe: INVALID subscription body from user', req.uid);
    return res.status(400).json({ error: "Invalid subscription" });
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET endpoint = $2, p256dh = $3, auth = $4, created_at = NOW()`,
      [req.uid, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    console.log('Push subscribe: SAVED OK for user', req.uid);
    res.json({ ok: true });
  } catch (err) {
    console.error('Push subscribe: DB error for user', req.uid, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/push/public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY, configured: vapidConfigured });
});

// ---- UNREAD DMS (for checking on login) ----
app.get("/api/dms/unread", authMiddleware, async (req, res) => {
  try {
    const safeUid = req.uid.replace(/_/g, '\\_');
    const { rows } = await pool.query(
      `SELECT DISTINCT chat_id, user_id AS from_uid
       FROM dm_messages
       WHERE (chat_id LIKE $1 ESCAPE '\\' OR chat_id LIKE $3 ESCAPE '\\')
         AND user_id != $2 AND read_at IS NULL`,
      [safeUid + '\\_%', req.uid, '%\\_' + safeUid]
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

// ---- QIURE MATCHMAKING QUEUE (improved with preference matching) ----
let _matchQueue = [];
const _recentMatches = new Map(); // uid → Set of matched uids (avoid repeats)

function _findBestMatch(queue) {
  if (queue.length < 2) return null;

  // Try to match by same theriotype/preference first
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const p1 = queue[i], p2 = queue[j];
      // Check recent matches to avoid repeats
      const p1Recent = _recentMatches.get(p1.uid) || new Set();
      const p2Recent = _recentMatches.get(p2.uid) || new Set();
      if (p1Recent.has(p2.uid) || p2Recent.has(p1.uid)) continue;

      // Prefer same theriotype
      if (p1.theriotype && p2.theriotype && p1.theriotype === p2.theriotype) {
        queue.splice(j, 1); queue.splice(i, 1);
        return [p1, p2];
      }
    }
  }

  // Fallback: match first two that haven't been matched recently
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const p1 = queue[i], p2 = queue[j];
      const p1Recent = _recentMatches.get(p1.uid) || new Set();
      if (!p1Recent.has(p2.uid)) {
        queue.splice(j, 1); queue.splice(i, 1);
        return [p1, p2];
      }
    }
  }

  // Last resort: match first two regardless
  return [queue.shift(), queue.shift()];
}

setInterval(async () => {
  // Clean stale entries (>2 min in queue)
  const now = Date.now();
  _matchQueue = _matchQueue.filter(q => {
    if (now - q.joinedAt > 120000) {
      const s = io.sockets.sockets.get(q.socketId);
      if (s) s.emit("match_timeout");
      return false;
    }
    return true;
  });

  if (_matchQueue.length >= 2) {
    const pair = _findBestMatch(_matchQueue);
    if (!pair) return;
    const [p1, p2] = pair;

    const s1 = io.sockets.sockets.get(p1.socketId);
    const s2 = io.sockets.sockets.get(p2.socketId);

    if (!s1 || !connectedUsers.has(p1.socketId)) {
      if (s2) _matchQueue.unshift(p2);
      return;
    }
    if (!s2 || !connectedUsers.has(p2.socketId)) {
      if (s1) _matchQueue.unshift(p1);
      return;
    }

    // Track recent matches
    if (!_recentMatches.has(p1.uid)) _recentMatches.set(p1.uid, new Set());
    if (!_recentMatches.has(p2.uid)) _recentMatches.set(p2.uid, new Set());
    _recentMatches.get(p1.uid).add(p2.uid);
    _recentMatches.get(p2.uid).add(p1.uid);
    // Clean old entries after 1 hour
    setTimeout(() => {
      const s1 = _recentMatches.get(p1.uid); if (s1) s1.delete(p2.uid);
      const s2 = _recentMatches.get(p2.uid); if (s2) s2.delete(p1.uid);
    }, 3600000);

    const chatId = [p1.uid, p2.uid].sort().join("_");

    try {
      await pool.query(
        "INSERT INTO dm_messages (chat_id, user_id, text, created_at) VALUES ($1, $2, $3, NOW())",
        [chatId, "system", "⚡ QIURE Match! Say hi to your new friend!"]
      );

      const payload1 = { chatId, partner: { uid: p2.uid, name: p2.name, photo: p2.photo, theriotype: p2.theriotype } };
      const payload2 = { chatId, partner: { uid: p1.uid, name: p1.name, photo: p1.photo, theriotype: p1.theriotype } };

      io.to(p1.socketId).emit("match_found", payload1);
      io.to(p2.socketId).emit("match_found", payload2);
      // Award XP for matching
      _awardXP(p1.uid, 5, p1.socketId, false);
      _awardXP(p2.uid, 5, p2.socketId, false);
      _incrementMissionProgress(p1.uid, 'make_friends', 1);
      _incrementMissionProgress(p2.uid, 'make_friends', 1);
      console.log(`Match made: ${p1.name} ↔ ${p2.name} (theriotype: ${p1.theriotype || 'any'}/${p2.theriotype || 'any'})`);
    } catch (e) { console.error("Match DB error", e); }
  }
}, 3000);

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
    const rooms = Array.from(socket.rooms);
    rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join("room_" + roomId);
    // Track user's current room for scoped push notifications
    const user = connectedUsers.get(socket.id);
    if (user) {
      _userRoomMap.set(user.uid, roomId);
      _incrementMissionProgress(user.uid, 'visit_rooms', 1);
    }
    console.log("Socket", socket.id, "joined room_" + roomId);
  });

  socket.on("join_dm", (chatId) => {
    const user = connectedUsers.get(socket.id);
    if (!user || !chatId || typeof chatId !== "string") return;
    const dmParts = chatId.split("_");
    if (dmParts.length !== 2 || !dmParts.includes(user.uid)) return;
    const rooms = Array.from(socket.rooms);
    rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.join("dm_" + chatId);
    console.log("Socket", socket.id, "joined dm_" + chatId);
  });

  socket.on("send_message", async (data) => {
    const { roomId, text, replyTo } = data;
    const user = connectedUsers.get(socket.id);
    if (!user) { socket.emit("message_error", "Not authenticated yet. Please wait a moment."); return; }
    if (!roomId || typeof roomId !== "string" || !text || !text.trim() || text.length > 500) return;
    if (!VALID_ROOMS.includes(roomId)) return;
    // Smart moderation check
    const muted = await _isUserMuted(user.uid);
    if (muted) { socket.emit("message_blocked", "⏳ You are temporarily muted. Try again later."); return; }
    const modResult = checkModeration(text.trim(), user.uid);
    if (modResult.blocked) {
      socket.emit("message_blocked", modResult.reason);
      _incrementToxicity(user.uid);
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
      // Get user level for the message
      const userXP = await pool.query(`SELECT xp FROM users WHERE id = $1`, [user.uid]);
      const userLevel = calculateLevel(userXP.rows[0]?.xp || 0);
      io.to("room_" + roomId).emit("new_message", {
        tempId: data.tempId,
        id: rows[0].id, room_id: roomId, user_id: user.uid,
        name: user.name, photo: user.photo, premium: user.premium,
        theriotype: user.theriotype || "", level: userLevel,
        text: rows[0].text, created_at: rows[0].created_at,
        reply_to: replyId, reply: replyData
      });
      // Track room activity + award XP (with daily cap)
      _trackRoomMessage(roomId);
      _roomLastActivity.set(roomId, Date.now());
      _awardXP(user.uid, 2, socket.id, true);
      _incrementMissionProgress(user.uid, 'send_messages', 1);
    } catch (err) { socket.emit("message_error", err.message); }
  });

  socket.on("send_dm", async (data) => {
    const { chatId, text, replyTo } = data;
    const user = connectedUsers.get(socket.id);
    if (!user) { socket.emit("message_error", "Not authenticated yet. Please wait a moment."); return; }
    if (!chatId || typeof chatId !== "string" || !text || !text.trim() || text.length > 500) return;
    const dmUids = chatId.split("_");
    if (dmUids.length !== 2 || !dmUids.includes(user.uid)) return;
    // Smart moderation check
    const muted = await _isUserMuted(user.uid);
    if (muted) { socket.emit("message_blocked", "⏳ You are temporarily muted. Try again later."); return; }
    const modResult = checkModeration(text.trim(), user.uid);
    if (modResult.blocked) {
      socket.emit("message_blocked", modResult.reason);
      _incrementToxicity(user.uid);
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
      // Get user level
      const userXP = await pool.query(`SELECT xp FROM users WHERE id = $1`, [user.uid]);
      const userLevel = calculateLevel(userXP.rows[0]?.xp || 0);
      const dmMsg = {
        id: rows[0].id, chat_id: chatId, user_id: user.uid,
        name: user.name, photo: user.photo, premium: user.premium,
        theriotype: user.theriotype || "", level: userLevel,
        text: rows[0].text, created_at: rows[0].created_at,
        reply_to: replyId, reply: replyData,
        tempId: data.tempId
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
      // Award XP for DM (with daily cap)
      _awardXP(user.uid, 2, socket.id, true);
      _incrementMissionProgress(user.uid, 'send_messages', 1);
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

  socket.on("matchmake_join", () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    let existing = _matchQueue.findIndex(q => q.uid === user.uid);
    if (existing === -1) {
      _matchQueue.push({ socketId: socket.id, uid: user.uid, theriotype: user.theriotype, name: user.name, photo: user.photo, premium: user.premium, joinedAt: Date.now() });
      console.log("Matchmaking joined:", user.name);
      // Notify user of queue position
      socket.emit("match_queue_status", { position: _matchQueue.length, total: _matchQueue.length });
    }
  });

  socket.on("matchmake_cancel", () => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;
    _matchQueue = _matchQueue.filter(q => q.uid !== user.uid);
    console.log("Matchmaking canceled:", user.name);
  });
});

// ---- NEW API ENDPOINTS FOR ALGORITHMS ----

// XP info endpoint
app.get("/api/users/me/xp", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT xp, level, login_streak FROM users WHERE id = $1", [req.uid]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    const xp = rows[0].xp || 0;
    const level = calculateLevel(xp);
    const currentLevelXP = xpForLevel(level);
    const nextLevelXP = xpForLevel(level + 1);
    res.json({
      xp, level,
      streak: rows[0].login_streak || 0,
      currentLevelXP,
      nextLevelXP,
      progress: Math.round(((xp - currentLevelXP) / (nextLevelXP - currentLevelXP)) * 100)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Room activity endpoint
app.get("/api/rooms/activity", authMiddleware, (req, res) => {
  res.json(_getRoomActivityStats());
});

// ---- DAILY MISSIONS SYSTEM ----
const DAILY_MISSIONS = [
  { key: 'send_messages', name: '💬 Messenger', desc: 'Send 5 messages in any room or DM', target: 5, xp: 100, icon: '💬' },
  { key: 'visit_rooms', name: '🚪 Explorer', desc: 'Visit 3 different rooms', target: 3, xp: 75, icon: '🚪' },
  { key: 'make_friends', name: '🤝 Social Butterfly', desc: 'Add or match with 1 person', target: 1, xp: 150, icon: '🤝' }
];

async function _incrementMissionProgress(uid, mission_key, amount) {
  try {
    const dateId = new Date().toISOString().split('T')[0];
    await pool.query(
      `INSERT INTO user_mission_progress (user_id, mission_key, date_id, progress)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, mission_key, date_id) 
       DO UPDATE SET progress = LEAST(user_mission_progress.progress + $4, 100)`,
      [uid, mission_key, dateId, amount]
    );
  } catch (e) { console.error("Mission progress error", e); }
}

app.get("/api/missions/daily", authMiddleware, async (req, res) => {
  try {
    const dateId = new Date().toISOString().split('T')[0];
    const { rows } = await pool.query("SELECT mission_key, progress, completed FROM user_mission_progress WHERE user_id = $1 AND date_id = $2", [req.uid, dateId]);
    // Merge definitions with user progress
    const missions = DAILY_MISSIONS.map(m => {
      const userProgress = rows.find(r => r.mission_key === m.key);
      return {
        ...m,
        progress: userProgress ? userProgress.progress : 0,
        completed: userProgress ? userProgress.completed : false,
        claimable: userProgress ? (userProgress.progress >= m.target && !userProgress.completed) : false
      };
    });
    res.json({ missions, dateId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/missions/claim", authMiddleware, async (req, res) => {
  try {
    const { mission_key } = req.body;
    const missionDef = DAILY_MISSIONS.find(m => m.key === mission_key);
    if (!missionDef) return res.status(400).json({ error: "Unknown mission" });

    const dateId = new Date().toISOString().split('T')[0];
    const { rows } = await pool.query(
      "UPDATE user_mission_progress SET completed = true WHERE user_id = $1 AND date_id = $2 AND mission_key = $3 AND progress >= $4 AND completed = false RETURNING *",
      [req.uid, dateId, mission_key, missionDef.target]
    );

    if (rows.length) {
      const xpGain = missionDef.xp;
      await pool.query("UPDATE users SET xp = xp + $2 WHERE id = $1", [req.uid, xpGain]);
      const userXP = await pool.query("SELECT xp FROM users WHERE id = $1", [req.uid]);
      const xp = userXP.rows[0].xp;
      const level = calculateLevel(xp);
      const currentLevelXP = xpForLevel(level);
      const nextLevelXP = xpForLevel(level + 1);

      for (const [socketId, u] of connectedUsers.entries()) {
        if (u.uid === req.uid) {
          io.to(socketId).emit("xp_update", {
            xp, level, gained: xpGain,
            progress: Math.round(((xp - currentLevelXP) / (nextLevelXP - currentLevelXP)) * 100)
          });
        }
      }
      res.json({ ok: true, xpGain });
    } else {
      res.status(400).json({ error: "Mission not complete or already claimed" });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- RECOMMENDATIONS API (improved: excludes banned + inactive users) ----
app.get("/api/users/recommendations", authMiddleware, async (req, res) => {
  try {
    const myTheriotype = (await pool.query("SELECT theriotype FROM users WHERE id = $1", [req.uid])).rows[0]?.theriotype;
    const baseFilters = `WHERE id != $1 
                 AND (is_banned = FALSE OR is_banned IS NULL)
                 AND last_seen > NOW() - INTERVAL '30 days'
                 AND id NOT IN (SELECT friend_id FROM friends WHERE user_id = $1)
                 AND id NOT IN (SELECT to_uid FROM friend_requests WHERE from_uid = $1)`;
    if (myTheriotype) {
      const query = `SELECT id as uid, name, photo, theriotype, level FROM users 
                 ${baseFilters}
                 ORDER BY (theriotype = $2) DESC, RANDOM() LIMIT 5`;
      const { rows } = await pool.query(query, [req.uid, myTheriotype]);
      return res.json(rows);
    }
    const query = `SELECT id as uid, name, photo, theriotype, level FROM users 
                 ${baseFilters}
                 ORDER BY RANDOM() LIMIT 5`;
    const { rows } = await pool.query(query, [req.uid]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start background timers
_startIcebreakerTimer();
_startActivityBroadcast();
console.log("[algorithms] Icebreaker bot + Activity broadcast started");

server.listen(PORT, () => console.log("Therian backend running on port " + PORT));

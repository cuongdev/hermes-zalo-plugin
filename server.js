// server.js
// HTTP bridge: SSE inbound (Zalo -> Hermes) + REST outbound (Hermes -> Zalo).
//
// Env vars:
//   ZALO_PLUGIN_PORT      (default 8787)
//   ZALO_PLUGIN_TOKEN     (optional shared secret; required on all routes if set)
//   ZALO_PLUGIN_HOST      (default 127.0.0.1 — keep loopback unless you add TLS)
//   ZALO_CREDENTIALS_PATH (default ./data/credentials.json)
//   ZALO_QR_PATH          (default ./data/qr.png)
//   ZALO_SELF_LISTEN      (1/true to receive own messages; default off)
//   ZALO_FORCE_QR         (1/true to ignore saved credentials and re-QR)

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZaloClient } from "./zaloClient.js";
import { ACTION_GROUPS, DEFAULT_GROUPS, ACTION_GROUP } from "./permissions.js";
import { credentialsPath, qrPath, cliMsgDir } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.ZALO_PLUGIN_PORT || "8787", 10);
const HOST = process.env.ZALO_PLUGIN_HOST || "127.0.0.1";
const TOKEN = process.env.ZALO_PLUGIN_TOKEN || "";
const CREDENTIALS_PATH = credentialsPath();
const QR_PATH = qrPath();
const SELF_LISTEN = /^(1|true|yes)$/i.test(process.env.ZALO_SELF_LISTEN || "");
const FORCE_QR = /^(1|true|yes)$/i.test(process.env.ZALO_FORCE_QR || "");
// Persisted undo-cache retention in days (0 = disable persistence, memory-only).
const CLIMSG_RETENTION_DAYS = (() => {
  const raw = process.env.ZALO_CLIMSG_RETENTION_DAYS;
  if (raw === undefined || raw === "") return 30;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 30;
})();

const client = new ZaloClient({
  credentialsPath: CREDENTIALS_PATH,
  qrPath: QR_PATH,
  selfListen: SELF_LISTEN,
  cliMsgDir: cliMsgDir(),
  cliMsgRetentionDays: CLIMSG_RETENTION_DAYS,
  infoCacheTtlMs: (() => {
    const n = parseInt(process.env.ZALO_INFO_CACHE_TTL || "", 10);
    return Number.isFinite(n) ? n * 1000 : 600000; // env in seconds, default 600s
  })(),
  infoMinIntervalMs: (() => {
    const n = parseInt(process.env.ZALO_INFO_MIN_INTERVAL_MS || "", 10);
    return Number.isFinite(n) ? n : 1500;
  })(),
});

// ── Access control: which zca-js actions are allowed ──────────────────────
// Groups by danger level: read < send < interact < manage < destructive.
//   ZALO_ALLOWED_ACTION_GROUPS  csv of groups, or "all"  (default read,send,interact)
//   ZALO_ALLOW_DESTRUCTIVE      true to permit the destructive group (off even under "all")
//   ZALO_ALLOWED_ACTIONS        csv of explicit method names to ALWAYS allow (overrides groups)
//   ZALO_DENIED_ACTIONS         csv of explicit method names to ALWAYS deny  (overrides everything)
const _csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

const ALLOWED_GROUPS = (() => {
  const raw = (process.env.ZALO_ALLOWED_ACTION_GROUPS || "").trim().toLowerCase();
  if (!raw) return new Set(DEFAULT_GROUPS);
  if (raw === "all") return new Set(ACTION_GROUPS);
  return new Set(_csv(raw).filter((g) => ACTION_GROUPS.includes(g)));
})();
const ALLOW_DESTRUCTIVE = /^(1|true|yes)$/i.test(process.env.ZALO_ALLOW_DESTRUCTIVE || "");
const ALLOWED_ACTIONS = new Set(_csv(process.env.ZALO_ALLOWED_ACTIONS));
const DENIED_ACTIONS = new Set(_csv(process.env.ZALO_DENIED_ACTIONS));

// destructive must be opted into explicitly, even if listed/under "all".
if (!ALLOW_DESTRUCTIVE) ALLOWED_GROUPS.delete("destructive");

/** Decide whether a zca-js method is permitted by the configured policy. */
function isActionAllowed(method) {
  if (DENIED_ACTIONS.has(method)) return { ok: false, reason: "explicitly denied (ZALO_DENIED_ACTIONS)" };
  if (ALLOWED_ACTIONS.has(method)) return { ok: true };
  const group = ACTION_GROUP[method];
  if (!group) return { ok: false, reason: `unknown action '${method}'` };
  if (group === "destructive" && !ALLOW_DESTRUCTIVE) {
    return { ok: false, reason: "destructive actions disabled (set ZALO_ALLOW_DESTRUCTIVE=true to enable)" };
  }
  if (!ALLOWED_GROUPS.has(group)) {
    return { ok: false, reason: `action group '${group}' not in ZALO_ALLOWED_ACTION_GROUPS` };
  }
  return { ok: true };
}

/** Express guard: 403 if the method isn't allowed. Returns true if allowed. */
function guardAction(method, res) {
  const verdict = isActionAllowed(method);
  if (!verdict.ok) {
    res.status(403).json({ error: `action '${method}' blocked: ${verdict.reason}` });
    return false;
  }
  return true;
}

console.log(
  `[bridge] access policy: groups=[${[...ALLOWED_GROUPS].join(",")}]` +
    ` destructive=${ALLOW_DESTRUCTIVE}` +
    (ALLOWED_ACTIONS.size ? ` +allow[${[...ALLOWED_ACTIONS].join(",")}]` : "") +
    (DENIED_ACTIONS.size ? ` -deny[${[...DENIED_ACTIONS].join(",")}]` : ""),
);

// Map first-class routes → the underlying zca-js action so they're gated by
// the SAME policy as /api/<method>. (GET read routes map to a read method.)
const ROUTE_ACTION = {
  "POST /send": "sendMessage",
  "POST /send-attachment": "uploadAttachment",
  "POST /send-sticker": "sendSticker",
  "POST /send-voice": "sendVoice",
  "POST /send-card": "sendCard",
  "POST /react": "addReaction",
  "POST /undo": "undo",
  "POST /typing": "sendTypingEvent",
  "POST /friend/request": "sendFriendRequest",
  "POST /friend/accept": "acceptFriendRequest",
  "POST /friend/reject": "rejectFriendRequest",
  "GET /friends": "getAllFriends",
  "GET /find-user": "findUser",
  "GET /groups": "getAllGroups",
  "GET /chat-info": "getUserInfo",
  "GET /stickers": "getStickers",
  "POST /group/create": "createGroup",
  "POST /group/add": "addUserToGroup",
  "POST /group/remove": "removeUserFromGroup",
  "POST /group/rename": "changeGroupName",
  "POST /group/deputy": "addGroupDeputy",
  "POST /group/leave": "leaveGroup",
  "POST /poll/create": "createPoll",
};

// ── SSE fan-out ───────────────────────────────────────────────────────────
const sseClients = new Set();
// Small ring buffer so a reconnecting consumer can replay missed events
// via Last-Event-ID (SSE standard).
const RING_SIZE = 200;
const ring = [];
let nextEventId = 1;

function pushEvent(type, payload) {
  const id = nextEventId++;
  const record = { id, type, payload };
  ring.push(record);
  if (ring.length > RING_SIZE) ring.shift();
  const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      /* dropped on next heartbeat */
    }
  }
}

client.on("message", (msg) => pushEvent("message", msg));
client.on("status", (s) => pushEvent("status", s));
client.on("session_dead", (d) => pushEvent("session_dead", d));
client.on("reaction", (r) => pushEvent("reaction", r));
client.on("undo", (u) => pushEvent("undo", u));
client.on("friend_event", (f) => pushEvent("friend_event", f));
client.on("group_event", (g) => pushEvent("group_event", g));

// ── Express ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));

// Action-policy middleware for the first-class routes (ROUTE_ACTION map above).
// /api/<method> is gated inside its own handler; lifecycle routes
// (/health, /qr, /events, /relogin, /shutdown) are never action-gated.
app.use((req, res, next) => {
  const method = ROUTE_ACTION[`${req.method} ${req.path}`];
  if (method) {
    const v = isActionAllowed(method);
    if (!v.ok) return res.status(403).json({ error: `action '${method}' blocked: ${v.reason}` });
  }
  next();
});

function checkAuth(req, res) {
  if (!TOKEN) return true;
  const provided =
    req.get("x-bridge-token") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    req.query.token;
  if (provided === TOKEN) return true;
  res.status(401).json({ error: "unauthorized" });
  return false;
}

// Expose the active access policy so the adapter/agent can surface what's
// permitted (and avoid attempting blocked actions blindly).
app.get("/policy", (req, res) => {
  if (!checkAuth(req, res)) return;
  const allowedActions = Object.keys(ACTION_GROUP).filter((m) => isActionAllowed(m).ok);
  res.json({
    groups: [...ALLOWED_GROUPS],
    allowDestructive: ALLOW_DESTRUCTIVE,
    customAllow: [...ALLOWED_ACTIONS],
    customDeny: [...DENIED_ACTIONS],
    allowedActionCount: allowedActions.length,
    totalActions: Object.keys(ACTION_GROUP).length,
    allowedActions,
  });
});

app.get("/health", (req, res) => {
  if (!checkAuth(req, res)) return;
  res.json({
    ok: true,
    loggedIn: client.loggedIn,
    sessionDead: !!client.sessionDead,
    sessionDeadReason: client.sessionDeadReason || null,
    ownId: client.ownId,
    qr: client.qrState ? client.qrState.status : null,
    sseClients: sseClients.size,
  });
});

// QR status + base64 image (for login UX). Returns current QR state.
app.get("/qr", (req, res) => {
  if (!checkAuth(req, res)) return;
  const state = client.qrState || { status: client.loggedIn ? "logged_in" : "none", image: null };
  res.json(state);
});

// Raw QR PNG (convenient to open in a browser/Preview).
app.get("/qr.png", (req, res) => {
  if (!checkAuth(req, res)) return;
  if (fs.existsSync(QR_PATH)) {
    res.sendFile(path.resolve(QR_PATH));
  } else {
    res.status(404).json({ error: "no qr available" });
  }
});

// Recover a dead/expired session: re-run login (QR by default). Returns once
// a new QR is generated; poll /qr or /qr.png to scan it, then /health.
app.post("/relogin", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const forceQR = req.body && req.body.forceQR === false ? false : true;
  // Kick off relogin in the background; respond immediately so the caller
  // can start polling /qr.
  client
    .relogin({ forceQR })
    .then((r) => console.log("[bridge] relogin complete via", r.method))
    .catch((e) => console.error("[bridge] relogin failed:", e && e.message ? e.message : e));
  res.json({ success: true, message: "relogin started; poll /qr then /qr.png to scan" });
});

// Graceful shutdown of the bridge. Stops the listener, closes SSE + file
// streams, then exits. Use to cleanly stop the Hermes Zalo agent.
app.post("/shutdown", async (req, res) => {
  if (!checkAuth(req, res)) return;
  res.json({ success: true, message: "shutting down" });
  await gracefulShutdown("http /shutdown");
});

// SSE inbound stream. Sends a heartbeat every 15s to defeat idle timeouts.
app.get("/events", (req, res) => {
  if (!checkAuth(req, res)) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 3000\n\n`);

  // Replay missed events if the client reconnected with Last-Event-ID.
  const lastId = parseInt(req.get("last-event-id") || req.query.lastEventId || "0", 10);
  if (lastId > 0) {
    for (const rec of ring) {
      if (rec.id > lastId) {
        res.write(
          `id: ${rec.id}\nevent: ${rec.type}\ndata: ${JSON.stringify(rec.payload)}\n\n`,
        );
      }
    }
  }

  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

function requireLogin(res) {
  if (!client.loggedIn) {
    res.status(503).json({ error: "not logged in" });
    return false;
  }
  return true;
}

// Send text. Body: { threadId, threadType, text, mentions?, quote? }
//   mentions: [{ pos, uid, len }]  — group @mention
//   quote:    SendMessageQuote captured from an inbound message (reply)
app.post("/send", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", text, mentions, quote } = req.body || {};
  if (!threadId || text == null) {
    return res.status(400).json({ error: "threadId and text required" });
  }
  try {
    const r = await client.sendText(threadId, threadType, text, mentions, quote);
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// Send attachment(s) by local file path(s). Body: { threadId, threadType, paths|path, caption? }
app.post("/send-attachment", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", caption } = req.body || {};
  const paths = req.body.paths || (req.body.path ? [req.body.path] : null);
  if (!threadId || !paths || !paths.length) {
    return res.status(400).json({ error: "threadId and paths required" });
  }
  for (const p of paths) {
    if (!fs.existsSync(p)) return res.status(400).json({ error: `file not found: ${p}` });
  }
  try {
    const r = await client.sendAttachment(threadId, threadType, paths, caption);
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// Send sticker. Body: { threadId, threadType, sticker: { id, cateId, type } }
app.post("/send-sticker", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", sticker } = req.body || {};
  if (!threadId || !sticker) return res.status(400).json({ error: "threadId and sticker required" });
  try {
    const r = await client.sendSticker(threadId, threadType, sticker);
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// Send voice. Body: { threadId, threadType, voiceUrl } OR { ..., path } (local file → real voice bubble)
app.post("/send-voice", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", voiceUrl, path: filePath } = req.body || {};
  if (!threadId || (!voiceUrl && !filePath)) {
    return res.status(400).json({ error: "threadId and (voiceUrl or path) required" });
  }
  try {
    let r;
    if (filePath) {
      if (!fs.existsSync(filePath)) return res.status(400).json({ error: `file not found: ${filePath}` });
      r = await client.sendVoiceLocal(threadId, threadType, filePath);
    } else {
      r = await client.sendVoice(threadId, threadType, voiceUrl);
    }
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// Typing indicator. Body: { threadId, threadType }
app.post("/typing", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user" } = req.body || {};
  if (!threadId) return res.status(400).json({ error: "threadId required" });
  await client.sendTyping(threadId, threadType);
  res.json({ success: true });
});

// Chat info. GET /chat-info?threadId=..&threadType=user|group
app.get("/chat-info", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const threadId = req.query.threadId;
  const threadType = req.query.threadType || "user";
  if (!threadId) return res.status(400).json({ error: "threadId required" });
  try {
    if (threadType === "group") {
      const info = await client.getGroupInfo(threadId);
      res.json({ threadId, type: "group", info });
    } else {
      const info = await client.getUserInfo(threadId);
      res.json({ threadId, type: "user", info });
    }
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// Search stickers by keyword. GET /stickers?keyword=hi&limit=5
app.get("/stickers", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const keyword = req.query.keyword;
  const limit = parseInt(req.query.limit || "5", 10);
  if (!keyword) return res.status(400).json({ error: "keyword required" });
  try {
    const stickers = await client.findStickers(keyword, limit);
    res.json({ success: true, stickers });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// ── Reactions / undo / reply / mention ───────────────────────────────────

// React to a message. Body: { threadId, threadType, msgId, cliMsgId?, icon }
// icon = a Reactions key (HEART, LIKE, HAHA, WOW, CRY, ANGRY, …) or raw icon string.
app.post("/react", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", msgId, cliMsgId, icon = "HEART" } = req.body || {};
  if (!threadId || !msgId) return res.status(400).json({ error: "threadId and msgId required" });
  try {
    const r = await client.react(threadId, threadType, msgId, cliMsgId, icon);
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// Recall/undo own message. Body: { threadId, threadType, msgId, cliMsgId? }
app.post("/undo", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", msgId, cliMsgId } = req.body || {};
  if (!threadId || !msgId) return res.status(400).json({ error: "threadId and msgId required" });
  try {
    const r = await client.undo(threadId, threadType, msgId, cliMsgId);
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// /send already supports reply + mention via optional body fields:
//   mentions: [{ pos, uid, len }]   (group @mention)
//   quote:    a SendMessageQuote object captured from an inbound message

// Send a contact card (danh thiếp). Body: { threadId, threadType, userId, phoneNumber? }
app.post("/send-card", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { threadId, threadType = "user", userId, phoneNumber } = req.body || {};
  if (!threadId || !userId) return res.status(400).json({ error: "threadId and userId required" });
  try {
    const r = await client.sendCard(threadId, threadType, userId, phoneNumber);
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// ── Friends ───────────────────────────────────────────────────────────────
app.post("/friend/request", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { userId, msg } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    res.json({ success: true, result: await client.sendFriendRequest(userId, msg) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
app.post("/friend/accept", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    res.json({ success: true, result: await client.acceptFriendRequest(userId) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
app.post("/friend/reject", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    res.json({ success: true, result: await client.rejectFriendRequest(userId) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
app.get("/friends", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  try {
    res.json({ success: true, friends: await client.getAllFriends() });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
app.get("/find-user", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: "phone required" });
  try {
    res.json({ success: true, user: await client.findUser(phone) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// ── Groups ────────────────────────────────────────────────────────────────
app.get("/groups", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  try {
    res.json({ success: true, groups: await client.getAllGroups() });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
// Friendly id+name list of groups and friends, for the setup wizard.
app.get("/contacts", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  try {
    res.json({ success: true, ...(await client.listContacts()) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
app.post("/group/create", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { name, members } = req.body || {};
  if (!Array.isArray(members) || !members.length) return res.status(400).json({ error: "members[] required" });
  try {
    res.json({ success: true, result: await client.createGroup(name, members) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
app.post("/group/add", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, members } = req.body || {};
  if (!groupId || !Array.isArray(members) || !members.length) return res.status(400).json({ error: "groupId and members[] required" });
  try {
    res.json({ success: true, result: await client.addUserToGroup(groupId, members) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
app.post("/group/remove", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, members } = req.body || {};
  if (!groupId || !Array.isArray(members) || !members.length) return res.status(400).json({ error: "groupId and members[] required" });
  try {
    res.json({ success: true, result: await client.removeUserFromGroup(groupId, members) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
app.post("/group/rename", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, name } = req.body || {};
  if (!groupId || !name) return res.status(400).json({ error: "groupId and name required" });
  try {
    res.json({ success: true, result: await client.changeGroupName(groupId, name) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
app.post("/group/deputy", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, members } = req.body || {};
  if (!groupId || !Array.isArray(members) || !members.length) return res.status(400).json({ error: "groupId and members[] required" });
  try {
    res.json({ success: true, result: await client.addGroupDeputy(groupId, members) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});
app.post("/group/leave", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, silent } = req.body || {};
  if (!groupId) return res.status(400).json({ error: "groupId required" });
  try {
    res.json({ success: true, result: await client.leaveGroup(groupId, silent) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// ── Generic passthrough: call ANY zca-js API method ───────────────────────
// POST /api/<method>  body { args: [...] }
// Covers the full zca-js surface (forwardMessage, deleteMessage, sendVideo,
// getGroupMembersInfo, reminders, mute/pin, profile, business, etc.).
// Pass args positionally exactly as zca-js expects; use "user"/"group" where
// a ThreadType is needed (auto-converted). Returns { success, result }.
app.post("/api/:method", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const method = req.params.method;
  if (!guardAction(method, res)) return;
  const args = (req.body && req.body.args) || [];
  try {
    const result = await client.callRaw(method, args);
    res.json({ success: true, result: result ?? null });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

// ── Poll ──────────────────────────────────────────────────────────────────
// Body: { groupId, question, options[], expiredTime?, allowMultiChoices?, ... }
app.post("/poll/create", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!requireLogin(res)) return;
  const { groupId, question, options, ...extra } = req.body || {};
  if (!groupId || !question || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: "groupId, question and options[>=2] required" });
  }
  try {
    res.json({ success: true, result: await client.createPoll(groupId, question, options, extra) });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

async function main() {
  _httpServer = app.listen(PORT, HOST, () => {
    console.log(`[bridge] listening on http://${HOST}:${PORT}`);
    if (!TOKEN) console.log("[bridge] WARNING: no ZALO_PLUGIN_TOKEN set (loopback only recommended)");
  });

  try {
    const result = await client.login({ forceQR: FORCE_QR });
    console.log(`[bridge] login complete via ${result.method}`);
  } catch (e) {
    console.error("[bridge] login failed:", e && e.message ? e.message : e);
    console.error("[bridge] server stays up; call /qr to retry login state.");
  }
}

let _httpServer = null;
let _shuttingDown = false;

async function gracefulShutdown(reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[bridge] graceful shutdown (${reason})…`);
  // Close SSE clients so consumers see the stream end.
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
  try {
    await client.shutdown();
  } catch {
    /* ignore */
  }
  if (_httpServer) {
    _httpServer.close(() => process.exit(0));
    // Hard exit if close hangs.
    setTimeout(() => process.exit(0), 3000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

main();

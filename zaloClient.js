// zaloClient.js
// Thin wrapper around zca-js handling login (cookie-first, QR fallback),
// message listening, and outbound sends. Emits normalised inbound events.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Zalo, ThreadType, LoginQRCallbackEventType, Reactions } from "zca-js";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";

/**
 * Read image dimensions from a local file by parsing the header bytes.
 * Supports PNG, JPEG, GIF, WebP, BMP — no external deps. Returns null if
 * dimensions can't be determined (zca-js then errors, surfaced to caller).
 */
async function readImageMetadata(filePath) {
  try {
    const buf = await fs.promises.readFile(filePath);
    const size = buf.length;
    let width = 0;
    let height = 0;

    if (buf.length >= 24 && buf.toString("ascii", 1, 4) === "PNG") {
      // PNG: IHDR at offset 16
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    } else if (buf[0] === 0xff && buf[1] === 0xd8) {
      // JPEG: scan SOF markers
      let off = 2;
      while (off < buf.length) {
        if (buf[off] !== 0xff) {
          off++;
          continue;
        }
        const marker = buf[off + 1];
        // SOF0..SOF15 except DHT(c4)/DNL(c8)/DAC(cc)
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          height = buf.readUInt16BE(off + 5);
          width = buf.readUInt16BE(off + 7);
          break;
        }
        off += 2 + buf.readUInt16BE(off + 2);
      }
    } else if (buf.toString("ascii", 0, 3) === "GIF") {
      width = buf.readUInt16LE(6);
      height = buf.readUInt16LE(8);
    } else if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const fmt = buf.toString("ascii", 12, 16);
      if (fmt === "VP8 ") {
        width = buf.readUInt16LE(26) & 0x3fff;
        height = buf.readUInt16LE(28) & 0x3fff;
      } else if (fmt === "VP8L") {
        const b = buf.readUInt32LE(21);
        width = (b & 0x3fff) + 1;
        height = ((b >> 14) & 0x3fff) + 1;
      } else if (fmt === "VP8X") {
        width = (buf.readUIntLE(24, 3) & 0xffffff) + 1;
        height = (buf.readUIntLE(27, 3) & 0xffffff) + 1;
      }
    } else if (buf.toString("ascii", 0, 2) === "BM") {
      width = buf.readInt32LE(18);
      height = Math.abs(buf.readInt32LE(22));
    }

    if (!width || !height) return null;
    return { width, height, size };
  } catch {
    return null;
  }
}

export class ZaloClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.credentialsPath  Where to persist credentials JSON.
   * @param {string} opts.qrPath           Where to write the QR PNG during login.
   * @param {boolean} opts.selfListen      Whether to receive our own messages.
   */
  constructor({ credentialsPath, qrPath, selfListen = false, cliMsgDir = null, cliMsgRetentionDays = 30, infoCacheTtlMs = 600000, infoMinIntervalMs = 1500 }) {
    super();
    this.credentialsPath = credentialsPath;
    this.qrPath = qrPath;
    this.selfListen = selfListen;
    this.api = null;
    this.ownId = null;
    this.loggedIn = false;
    this.sessionDead = false;
    this.sessionDeadReason = null;
    this._qrState = null; // { image, status } during a QR login flow
    // Cache msgId -> { cliMsgId, ts } so undo() works without the caller
    // knowing the client id (zca-js generates clientId internally and doesn't
    // return it; the listener echo carries the real cliMsgId).
    // Persisted to daily-rotated JSONL files under cliMsgDir, kept 30 days,
    // and reloaded on startup so undo survives restarts. In-memory Map is the
    // fast path, bounded so RAM can't grow unbounded.
    this._cliMsgIds = new Map();
    this._cliMsgMaxEntries = 50000;
    // Retention window for the persisted cache. Configurable; 0 or negative
    // disables persistence (memory-only). Default 30 days.
    this._cliMsgRetentionDays = Number.isFinite(cliMsgRetentionDays) ? cliMsgRetentionDays : 30;
    this._cliMsgPersist = this._cliMsgRetentionDays > 0;
    this._cliMsgDir =
      cliMsgDir || path.join(path.dirname(this.credentialsPath), "climsgids");
    this._cliMsgStream = null;
    this._cliMsgStreamDay = null;

    // ── Info cache + rate limiter (anti rate-limit / account-lock) ──────────
    // zca-js is an unofficial API; hammering getUserInfo/getGroupInfo/getAll*
    // risks a temporary block or "abnormal activity" flag. We:
    //   1) cache read-info results by key with a TTL (default 10 min);
    //   2) serialize info calls through a queue with a minimum gap between them;
    //   3) on a suspected rate-limit error, apply exponential backoff and serve
    //      stale cache (if any) instead of hammering further.
    this._infoCache = new Map(); // key -> { value, ts }
    this._infoCacheTtlMs = Number.isFinite(infoCacheTtlMs) ? infoCacheTtlMs : 600000;
    this._infoMinIntervalMs = Number.isFinite(infoMinIntervalMs) ? infoMinIntervalMs : 1500;
    this._infoLastCallAt = 0;
    this._infoQueue = Promise.resolve(); // serializes info calls
    this._infoBackoffUntil = 0; // epoch ms; while > now, refuse fresh calls
    this._infoBackoffMs = 0; // current backoff window (grows on repeated limits)
  }

  // ── Rate-limited, cached read-info gateway ────────────────────────────────
  _isRateLimitError(err) {
    const msg = String((err && err.message) || err || "").toLowerCase();
    return (
      msg.includes("rate") ||
      msg.includes("too many") ||
      msg.includes("limit") ||
      msg.includes("429") ||
      msg.includes("abnormal") ||
      msg.includes("spam")
    );
  }

  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Run a read-info fetch with caching + serialized rate limiting + backoff.
   * @param {string} key      cache key (e.g. "group:123")
   * @param {Function} fetcher async () => value
   * @param {object} opts      { ttlMs?, force? }
   */
  async _cachedInfo(key, fetcher, { ttlMs = this._infoCacheTtlMs, force = false } = {}) {
    const now = Date.now();
    const hit = this._infoCache.get(key);
    if (!force && hit && now - hit.ts < ttlMs) {
      return hit.value;
    }
    // If we're in a backoff window, serve stale cache rather than hammering.
    if (now < this._infoBackoffUntil) {
      if (hit) {
        console.warn(`[zalo] info backoff active; serving stale cache for ${key}`);
        return hit.value;
      }
      const waitS = Math.ceil((this._infoBackoffUntil - now) / 1000);
      throw new Error(`Zalo info calls are backing off (rate-limited); retry in ~${waitS}s`);
    }
    // Serialize through the queue so concurrent callers don't burst.
    const run = this._infoQueue.then(async () => {
      const gap = Date.now() - this._infoLastCallAt;
      if (gap < this._infoMinIntervalMs) await this._sleep(this._infoMinIntervalMs - gap);
      try {
        const value = await fetcher();
        this._infoLastCallAt = Date.now();
        this._infoCache.set(key, { value, ts: Date.now() });
        // success resets backoff
        this._infoBackoffMs = 0;
        this._infoBackoffUntil = 0;
        return value;
      } catch (e) {
        this._infoLastCallAt = Date.now();
        if (this._isRateLimitError(e)) {
          this._infoBackoffMs = Math.min(this._infoBackoffMs ? this._infoBackoffMs * 2 : 5000, 300000);
          this._infoBackoffUntil = Date.now() + this._infoBackoffMs;
          console.warn(`[zalo] rate-limit suspected on ${key}; backing off ${this._infoBackoffMs}ms`);
          if (hit) return hit.value; // serve stale on limit
        }
        throw e;
      }
    });
    // keep the queue chained but don't let a rejection break it
    this._infoQueue = run.catch(() => {});
    return run;
  }

  _loadCredentials() {
    try {
      if (fs.existsSync(this.credentialsPath)) {
        const raw = fs.readFileSync(this.credentialsPath, "utf-8");
        const c = JSON.parse(raw);
        if (c && c.cookie && c.imei && c.userAgent) return c;
      }
    } catch (e) {
      console.error("[zalo] failed to read credentials:", e.message);
    }
    return null;
  }

  _saveCredentials(cred) {
    try {
      fs.mkdirSync(path.dirname(this.credentialsPath), { recursive: true });
      fs.writeFileSync(this.credentialsPath, JSON.stringify(cred, null, 2), "utf-8");
      console.log("[zalo] credentials saved to", this.credentialsPath);
    } catch (e) {
      console.error("[zalo] failed to save credentials:", e.message);
    }
  }

  get qrState() {
    return this._qrState;
  }

  // ── cliMsgId persistence (daily-rotated JSONL, 30-day retention) ──────────

  _cliMsgDayStr(d = new Date()) {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  }

  _cliMsgFilePath(day) {
    return path.join(this._cliMsgDir, `climsgids-${day}.jsonl`);
  }

  /** Record a msgId -> cliMsgId mapping in memory and append to today's file. */
  _recordCliMsgId(msgId, cliMsgId) {
    const key = String(msgId);
    if (this._cliMsgIds.has(key)) return; // already known
    const ts = Date.now();
    this._cliMsgIds.set(key, { cliMsgId: String(cliMsgId), ts });

    // Bound RAM (rare; persistence holds the durable copy).
    if (this._cliMsgIds.size > this._cliMsgMaxEntries) {
      const it = this._cliMsgIds.keys();
      for (let i = 0; i < 5000; i++) {
        const k = it.next().value;
        if (k === undefined) break;
        this._cliMsgIds.delete(k);
      }
    }

    try {
      if (!this._cliMsgPersist) return; // persistence disabled (retention<=0)
      const day = this._cliMsgDayStr();
      if (!this._cliMsgStream || this._cliMsgStreamDay !== day) {
        if (this._cliMsgStream) this._cliMsgStream.end();
        fs.mkdirSync(this._cliMsgDir, { recursive: true });
        this._cliMsgStream = fs.createWriteStream(this._cliMsgFilePath(day), { flags: "a" });
        this._cliMsgStreamDay = day;
        this._pruneCliMsgFiles(); // prune on each daily rotation
      }
      this._cliMsgStream.write(JSON.stringify({ m: key, c: String(cliMsgId), t: ts }) + "\n");
    } catch (e) {
      console.error("[zalo] cliMsgId persist failed:", e.message);
    }
  }

  /** Resolve a cliMsgId from memory (fast path). */
  _lookupCliMsgId(msgId) {
    const rec = this._cliMsgIds.get(String(msgId));
    return rec ? rec.cliMsgId : null;
  }

  /** Load the last `retentionDays` of JSONL files into memory on startup. */
  _loadCliMsgCache() {
    try {
      if (!this._cliMsgPersist) return; // persistence disabled
      if (!fs.existsSync(this._cliMsgDir)) return;
      const cutoff = Date.now() - this._cliMsgRetentionDays * 86400_000;
      const files = fs
        .readdirSync(this._cliMsgDir)
        .filter((f) => /^climsgids-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort(); // chronological; later files overwrite earlier (newest wins)
      let loaded = 0;
      for (const f of files) {
        const dayStr = f.slice("climsgids-".length, "climsgids-".length + 10);
        const dayMs = Date.parse(dayStr + "T00:00:00Z");
        if (!Number.isNaN(dayMs) && dayMs < cutoff - 86400_000) continue; // skip too-old files
        const full = path.join(this._cliMsgDir, f);
        for (const line of fs.readFileSync(full, "utf-8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o.m && o.c && (o.t || 0) >= cutoff) {
              this._cliMsgIds.set(String(o.m), { cliMsgId: String(o.c), ts: o.t || 0 });
              loaded++;
            }
          } catch {
            /* skip corrupt line */
          }
        }
      }
      if (loaded) console.log(`[zalo] loaded ${loaded} cached cliMsgId mappings (<=30d)`);
    } catch (e) {
      console.error("[zalo] cliMsgId cache load failed:", e.message);
    }
  }

  /** Delete JSONL files older than the retention window. */
  _pruneCliMsgFiles() {
    try {
      if (!fs.existsSync(this._cliMsgDir)) return;
      const cutoffDay = this._cliMsgDayStr(new Date(Date.now() - this._cliMsgRetentionDays * 86400_000));
      for (const f of fs.readdirSync(this._cliMsgDir)) {
        const m = f.match(/^climsgids-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (m && m[1] < cutoffDay) {
          try {
            fs.unlinkSync(path.join(this._cliMsgDir, f));
            console.log("[zalo] pruned old cliMsgId file:", f);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      console.error("[zalo] cliMsgId prune failed:", e.message);
    }
  }

  /**
   * Attempt login. If saved credentials exist, use them. Otherwise run the
   * QR flow: writes the QR PNG, exposes base64 via qrState, resolves once the
   * phone confirms. Throws on hard failure.
   */
  async login({ forceQR = false } = {}) {
    const zalo = new Zalo({
      // Always self-listen at the zca-js layer so we can capture the real
      // cliMsgId of our own sent messages (needed for undo). We still filter
      // self messages before emitting to SSE (see _normaliseMessage), unless
      // the operator explicitly opted into selfListen.
      selfListen: true,
      logging: false,
      imageMetadataGetter: readImageMetadata,
    });

    const saved = forceQR ? null : this._loadCredentials();
    if (saved) {
      try {
        console.log("[zalo] logging in with saved credentials...");
        this.api = await zalo.login(saved);
        await this._afterLogin();
        return { method: "cookie" };
      } catch (e) {
        console.error("[zalo] cookie login failed, falling back to QR:", e.message);
      }
    }

    // QR login. Renders a scannable QR + live countdown in the terminal when
    // stdout is a TTY (interactive `login`/`setup`); a background service (no
    // TTY) just logs one line so its log files stay clean.
    console.log("[zalo] starting QR login...");
    this._qrState = { status: "generating", image: null };

    const tty = !!process.stdout.isTTY;
    let qrterm = null; // optional dep, imported lazily on first QR
    let countdownTimer = null;
    const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    const stopCountdown = (finalLine) => {
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
      if (tty) process.stdout.write("\r\x1b[2K" + (finalLine ? finalLine + "\n" : ""));
    };
    const startCountdown = () => {
      if (!tty) return;
      let left = 100; // zca-js expires the QR after 100s
      const tick = () => {
        process.stdout.write(
          `\r\x1b[2K  ⏳ Tự làm mới sau ${fmt(Math.max(left, 0))} nếu chưa quét  ·  Ctrl-C để huỷ`,
        );
        left--;
      };
      tick();
      countdownTimer = setInterval(tick, 1000);
      if (countdownTimer.unref) countdownTimer.unref();
    };
    const showQr = async (token) => {
      if (!tty) {
        console.log("[zalo] QR generated. Scan", this.qrPath, "with the Zalo app.");
        return;
      }
      if (qrterm === null) {
        try { qrterm = (await import("qrcode-terminal")).default; } catch { qrterm = false; }
      }
      const finishWith = (qrText) => {
        console.log("");
        if (qrText) console.log(qrText);
        console.log("  📱 Mở Zalo → (+) → Quét mã QR, chĩa điện thoại vào màn hình");
        console.log(`  (fallback) hoặc mở ảnh: ${this.qrPath}`);
        startCountdown();
      };
      if (qrterm) qrterm.generate(token, { small: true }, finishWith);
      else finishWith(null);
    };

    this.api = await zalo.loginQR(
      { userAgent: DEFAULT_UA, qrPath: this.qrPath },
      (event) => {
        switch (event.type) {
          case LoginQRCallbackEventType.QRCodeGenerated:
            this._qrState = { status: "waiting_scan", image: event.data.image };
            // zca-js does NOT auto-save the PNG when a callback is supplied, so
            // persist it ourselves (for /qr.png and the file fallback).
            try {
              fs.writeFileSync(
                this.qrPath,
                String(event.data.image || "").replace(/^data:image\/png;base64,/, ""),
                "base64",
              );
            } catch {
              /* ignore */
            }
            // The QR image encodes event.data.token (a zaloapp.com/qr URL), NOT
            // event.data.code (the polling session id) — render the token.
            showQr(event.data.token);
            break;
          case LoginQRCallbackEventType.QRCodeScanned:
            this._qrState = {
              status: "scanned",
              image: null,
              displayName: event.data.display_name,
            };
            stopCountdown(`  ✓ Đã quét bởi ${event.data.display_name} — xác nhận trên điện thoại…`);
            if (!tty) console.log("[zalo] QR scanned by", event.data.display_name, "- confirm on phone.");
            break;
          case LoginQRCallbackEventType.QRCodeExpired:
            this._qrState = { status: "expired", image: null };
            stopCountdown("  ⏳ QR hết hạn — đang tạo mã mới…");
            if (!tty) console.log("[zalo] QR expired; regenerating.");
            try { event.actions?.retry?.(); } catch {
              /* ignore */
            }
            break;
          case LoginQRCallbackEventType.QRCodeDeclined:
            this._qrState = { status: "declined", image: null };
            stopCountdown("  ✗ Bị từ chối trên điện thoại — đang tạo mã mới…");
            if (!tty) console.log("[zalo] QR login declined; regenerating.");
            try { event.actions?.retry?.(); } catch {
              /* ignore */
            }
            break;
          case LoginQRCallbackEventType.GotLoginInfo:
            // Persist cookie/imei/userAgent so we don't need QR next time.
            stopCountdown();
            this._saveCredentials({
              cookie: event.data.cookie,
              imei: event.data.imei,
              userAgent: event.data.userAgent,
            });
            this._qrState = { status: "logged_in", image: null };
            break;
        }
      },
    );

    await this._afterLogin();
    return { method: "qr" };
  }

  async _afterLogin() {
    this.loggedIn = true;
    this._loadCliMsgCache(); // reload persisted msgId→cliMsgId (<=30d) for undo
    try {
      this.ownId = await this.api.getOwnId();
    } catch {
      this.ownId = null;
    }
    console.log("[zalo] logged in. ownId =", this.ownId);
    this._wireListeners();
    // retryOnClose: zca-js auto-reconnects the Zalo websocket on drop.
    this.api.listener.start({ retryOnClose: true });
  }

  _wireListeners() {
    const listener = this.api.listener;

    listener.on("connected", () => {
      console.log("[zalo] listener connected");
      this.sessionDead = false;
      this.emit("status", { connected: true });
    });
    listener.on("disconnected", (code, reason) => {
      // Transient drop; zca-js will auto-retry (retryOnClose). Just surface it.
      console.log("[zalo] listener disconnected", code, reason);
      this.emit("status", { connected: false, transient: true, code, reason });
    });
    listener.on("closed", (code, reason) => {
      // Permanent close: retries exhausted OR a fatal code (session killed).
      // 3000 = DuplicateConnection (logged in elsewhere), 3003 = KickConnection.
      console.log("[zalo] listener CLOSED (session likely dead)", code, reason);
      this.loggedIn = false;
      this.sessionDead = true;
      this.sessionDeadReason = `code=${code} reason=${reason || ""}`.trim();
      this.emit("status", { connected: false, dead: true, code, reason });
      this.emit("session_dead", {
        code,
        reason: reason || "",
        message:
          code === 3000
            ? "Zalo session ended: account logged in from another device/Zalo Web."
            : code === 3003
              ? "Zalo session was kicked by the server."
              : "Zalo session closed (cookie expired or network). Re-scan QR to recover.",
      });
    });
    listener.on("error", (err) => {
      console.error("[zalo] listener error:", err);
    });

    listener.on("message", (message) => {
      try {
        const isGroup = message.type === ThreadType.Group;
        const d = message.data || {};
        // Always cache msgId -> cliMsgId (incl. our own messages) for undo.
        if (d.msgId && d.cliMsgId) {
          this._recordCliMsgId(d.msgId, d.cliMsgId);
        }
        console.log(
          `[zalo] RAW message: type=${isGroup ? "group" : "user"} thread=${message.threadId} ` +
            `from=${d.uidFrom} self=${message.isSelf} msgType=${d.msgType} ` +
            `content=${typeof d.content === "string" ? JSON.stringify(d.content).slice(0, 80) : JSON.stringify(d.content).slice(0, 400)}`,
        );
        const ev = this._normaliseMessage(message);
        if (ev) this.emit("message", ev);
      } catch (e) {
        console.error("[zalo] failed to normalise message:", e.message);
      }
    });

    // Reactions (thả tim/like…) on messages.
    listener.on("reaction", (reaction) => {
      try {
        const d = reaction.data || {};
        this.emit("reaction", {
          threadId: String(reaction.threadId),
          threadType: reaction.type === ThreadType.Group ? "group" : "user",
          senderId: String(d.uidFrom || ""),
          msgId: String(d.content?.rMsg?.[0]?.gMsgID || d.msgId || ""),
          icon: d.content?.rIcon || "",
          rType: d.content?.rType,
          isSelf: !!reaction.isSelf,
        });
      } catch (e) {
        console.error("[zalo] reaction normalise failed:", e.message);
      }
    });

    // Message undo/recall (thu hồi).
    listener.on("undo", (undo) => {
      try {
        const d = undo.data || {};
        this.emit("undo", {
          threadId: String(undo.threadId),
          threadType: undo.type === ThreadType.Group ? "group" : "user",
          senderId: String(d.uidFrom || ""),
          msgId: String(d.content?.globalMsgId || d.msgId || ""),
          isSelf: !!undo.isSelf,
        });
      } catch (e) {
        console.error("[zalo] undo normalise failed:", e.message);
      }
    });

    // Friend events (requests, accepts, etc.).
    listener.on("friend_event", (ev) => {
      try {
        this.emit("friend_event", { type: ev.type, data: ev.data, isSelf: !!ev.isSelf });
      } catch (e) {
        console.error("[zalo] friend_event failed:", e.message);
      }
    });

    // Group events (join/leave/rename/admin, etc.).
    listener.on("group_event", (ev) => {
      try {
        this.emit("group_event", { type: ev.type, data: ev.data, isSelf: !!ev.isSelf });
      } catch (e) {
        console.error("[zalo] group_event failed:", e.message);
      }
    });
  }

  /**
   * Convert a zca-js Message into a flat inbound event for Hermes.
   * Skips our own messages unless selfListen is on.
   */
  _normaliseMessage(message) {
    const isGroup = message.type === ThreadType.Group;
    const data = message.data || {};

    if (message.isSelf && !this.selfListen) return null;

    const msgType = data.msgType || "";
    let text = "";
    let attachment = null;
    let media = null; // { kind, url, fileName, ext, mime, size }

    if (typeof data.content === "string") {
      text = data.content;
    } else if (data.content && typeof data.content === "object") {
      const c = data.content;
      let params = {};
      try {
        params = typeof c.params === "string" ? JSON.parse(c.params) : c.params || {};
      } catch {
        params = {};
      }

      attachment = {
        title: c.title || "",
        description: c.description || "",
        href: c.href || "",
        thumb: c.thumb || "",
        type: c.type || msgType || "",
        params,
      };

      // Classify and extract a downloadable URL by msgType.
      const kindMap = {
        "chat.photo": "image",
        "chat.gif": "image",
        "chat.voice": "voice",
        "chat.video.msg": "video",
        "share.file": "file",
        "chat.sticker": "sticker",
        "chat.recommended": "contact",
        "chat.location.new": "location",
      };
      const kind = kindMap[msgType] || "other";

      if (kind === "voice") {
        const url = params.m4a || c.href || "";
        media = { kind, url, fileName: "voice.aac", ext: "aac", mime: "audio/aac", size: params.fileSize || 0 };
        text = "[voice message]";
      } else if (kind === "image") {
        media = {
          kind,
          url: params.hd || c.href || "",
          fileName: "image.jpg",
          ext: "jpg",
          mime: "image/jpeg",
          size: params.fileSize || 0,
          width: params.width || 0,
          height: params.height || 0,
        };
        text = c.description || "";
      } else if (kind === "video") {
        media = { kind, url: c.href || "", fileName: "video.mp4", ext: "mp4", mime: "video/mp4", size: params.fileSize || 0 };
        text = c.description || "";
      } else if (kind === "file") {
        const ext = params.fileExt || (c.title || "").split(".").pop() || "bin";
        media = { kind, url: c.href || "", fileName: c.title || `file.${ext}`, ext, mime: "application/octet-stream", size: params.fileSize || 0 };
        text = `[file: ${c.title || ""}]`;
      } else if (kind === "contact") {
        // Vietnamese: danh thiếp. description holds {phone, qrCodeUrl, gUid}.
        let info = {};
        try {
          info = typeof c.description === "string" ? JSON.parse(c.description) : c.description || {};
        } catch {
          info = {};
        }
        attachment.contact = { name: c.title || "", phone: info.phone || "", gUid: info.gUid || "" };
        text = `[contact: ${c.title || ""}${info.phone ? " " + info.phone : ""}]`;
      } else if (kind === "sticker") {
        text = "[sticker]";
      } else if (kind === "location") {
        text = `[location]`;
      } else {
        text = c.title || c.description || "";
      }
    }

    return {
      messageId: String(data.msgId || data.cliMsgId || Date.now()),
      cliMsgId: String(data.cliMsgId || ""),
      threadId: String(message.threadId),
      threadType: isGroup ? "group" : "user",
      senderId: String(data.uidFrom || ""),
      senderName: data.dName || "",
      text,
      attachment,
      media,
      msgType,
      ts: String(data.ts || Date.now()),
      isSelf: !!message.isSelf,
      // Real @mentions (group only): list of mentioned uids so the adapter can
      // detect being addressed without guessing from text.
      mentions: Array.isArray(data.mentions)
        ? data.mentions.map((mn) => String(mn && mn.uid ? mn.uid : "")).filter(Boolean)
        : [],
      // uid of the owner of the quoted message (set when this is a reply). If it
      // equals our ownId, the user is replying to the bot.
      quotedOwnerId: data.quote && data.quote.ownerId ? String(data.quote.ownerId) : "",
      // Enough to build a SendMessageQuote for replies.
      quote: {
        content: typeof data.content === "string" ? data.content : data.content,
        msgType: data.msgType,
        propertyExt: data.propertyExt,
        uidFrom: data.uidFrom,
        msgId: data.msgId,
        cliMsgId: data.cliMsgId,
        ts: data.ts,
        ttl: data.ttl,
      },
    };
  }

  _threadTypeEnum(threadType) {
    return threadType === "group" ? ThreadType.Group : ThreadType.User;
  }

  // ── Outbound ──────────────────────────────────────────────────────────

  async sendText(threadId, threadType, text, mentions, quote) {
    const content = { msg: String(text) };
    if (Array.isArray(mentions) && mentions.length) content.mentions = mentions;
    if (quote) content.quote = quote;
    return await this.api.sendMessage(content, String(threadId), this._threadTypeEnum(threadType));
  }

  // ── Reactions ──────────────────────────────────────────────────────────
  /** React to a message. iconName is a key of Reactions (HEART, LIKE, HAHA…) or a raw icon string. */
  async react(threadId, threadType, msgId, cliMsgId, iconName) {
    const icon = Reactions[iconName] !== undefined ? Reactions[iconName] : iconName;
    const dest = {
      data: { msgId: String(msgId), cliMsgId: String(cliMsgId || msgId) },
      threadId: String(threadId),
      type: this._threadTypeEnum(threadType),
    };
    return await this.api.addReaction(icon, dest);
  }

  // ── Undo (thu hồi) ───────────────────────────────────────────────────────
  async undo(threadId, threadType, msgId, cliMsgId) {
    let cli = cliMsgId && String(cliMsgId) !== String(msgId) ? String(cliMsgId) : null;
    // Resolve the real cliMsgId from the persisted cache. A just-sent message
    // may take ~1s to echo back through the listener, so poll briefly.
    if (!cli) {
      for (let i = 0; i < 12 && !cli; i++) {
        cli = this._lookupCliMsgId(msgId);
        if (!cli) await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!cli) {
      throw new Error(
        "undo: real cliMsgId not found for this msgId (need the message to have passed through the listener)",
      );
    }
    return await this.api.undo(
      { msgId: String(msgId), cliMsgId: cli },
      String(threadId),
      this._threadTypeEnum(threadType),
    );
  }

  // ── Contact card (danh thiếp) ─────────────────────────────────────────────
  async sendCard(threadId, threadType, userId, phoneNumber) {
    const opts = { userId: String(userId) };
    if (phoneNumber) opts.phoneNumber = String(phoneNumber);
    return await this.api.sendCard(opts, String(threadId), this._threadTypeEnum(threadType));
  }

  // ── Friends ───────────────────────────────────────────────────────────────
  async sendFriendRequest(userId, msg) {
    return await this.api.sendFriendRequest(String(msg || "Xin chào"), String(userId));
  }
  async acceptFriendRequest(userId) {
    return await this.api.acceptFriendRequest(String(userId));
  }
  async rejectFriendRequest(userId) {
    return await this.api.rejectFriendRequest(String(userId));
  }
  async getAllFriends() {
    return await this._cachedInfo("friends:all", () => this.api.getAllFriends());
  }
  async findUser(phoneNumber) {
    return await this.api.findUser(String(phoneNumber));
  }

  // ── Groups ────────────────────────────────────────────────────────────────
  async getAllGroups() {
    return await this._cachedInfo("groups:all", () => this.api.getAllGroups());
  }
  async getGroupMembers(groupId) {
    // getGroupInfo returns membership; getGroupMembersInfo enriches profiles.
    return await this.api.getGroupInfo(String(groupId));
  }
  async createGroup(name, members) {
    return await this.api.createGroup({ name: name || undefined, members: members.map(String) });
  }
  async addUserToGroup(groupId, memberIds) {
    return await this.api.addUserToGroup(memberIds.map(String), String(groupId));
  }
  async removeUserFromGroup(groupId, memberIds) {
    return await this.api.removeUserFromGroup(memberIds.map(String), String(groupId));
  }
  async changeGroupName(groupId, name) {
    return await this.api.changeGroupName(String(name), String(groupId));
  }
  async addGroupDeputy(groupId, memberIds) {
    return await this.api.addGroupDeputy(memberIds.map(String), String(groupId));
  }
  async leaveGroup(groupId, silent = false) {
    return await this.api.leaveGroup(String(groupId), !!silent);
  }

  // ── Poll ──────────────────────────────────────────────────────────────────
  async createPoll(groupId, question, options, extra = {}) {
    return await this.api.createPoll(
      { question: String(question), options: options.map(String), ...extra },
      String(groupId),
    );
  }

  /**
   * Send one or more local file paths as attachments (images, files, video).
   * zca-js routes by extension automatically.
   */
  async sendAttachment(threadId, threadType, filePaths, caption) {
    const attachments = Array.isArray(filePaths) ? filePaths : [filePaths];
    const content = { msg: caption ? String(caption) : "", attachments };
    return await this.api.sendMessage(content, String(threadId), this._threadTypeEnum(threadType));
  }

  async sendSticker(threadId, threadType, sticker) {
    // sticker: { id, cateId, type } per zca-js StickerDetail
    return await this.api.sendSticker(sticker, String(threadId), this._threadTypeEnum(threadType));
  }

  async sendVoice(threadId, threadType, voiceUrl) {
    return await this.api.sendVoice({ voiceUrl }, String(threadId), this._threadTypeEnum(threadType));
  }

  /**
   * Send a LOCAL audio file as a real voice bubble: upload it (as "others")
   * to obtain a public fileUrl, then call sendVoice with that URL.
   * Zalo voice bubbles want m4a/aac. Returns the sendVoice result.
   */
  async sendVoiceLocal(threadId, threadType, filePath) {
    const type = this._threadTypeEnum(threadType);
    const uploaded = await this.api.uploadAttachment([filePath], String(threadId), type);
    const first = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    const url = first && (first.fileUrl || first.normalUrl);
    if (!url) throw new Error("upload did not return a fileUrl for voice");
    return await this.api.sendVoice({ voiceUrl: url }, String(threadId), type);
  }

  async sendTyping(threadId, threadType) {
    try {
      return await this.api.sendTypingEvent(String(threadId), this._threadTypeEnum(threadType));
    } catch {
      return null;
    }
  }

  async getUserInfo(userId) {
    try {
      return await this._cachedInfo(`user:${userId}`, () => this.api.getUserInfo(String(userId)));
    } catch {
      return null;
    }
  }

  /** Search stickers by keyword and return full details ({id, cateId, type, ...}). */
  async findStickers(keyword, limit = 5) {
    const ids = await this.api.getStickers(String(keyword));
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const slice = ids.slice(0, limit);
    const details = await this.api.getStickersDetail(slice);
    return details || [];
  }

  async getGroupInfo(groupId) {
    try {
      return await this._cachedInfo(`group:${groupId}`, () => this.api.getGroupInfo(String(groupId)));
    } catch {
      return null;
    }
  }

  /**
   * Friendly contact list for setup: every group (id + name) and every friend
   * (id + name). Used by the Hermes setup wizard so users can pick allowlist
   * entries by name instead of hunting for raw IDs.
   */
  async listContacts() {
    const groups = [];
    const friends = [];
    // Groups: getAllGroups returns only {gridVerMap:{id:ver}}; fetch names via
    // getGroupInfo. Chunk the ids (some accounts have stale/left groups in the
    // map that make a single huge call fail with "Tham số không hợp lệ"); a bad
    // chunk is skipped with a placeholder name rather than failing the whole list.
    try {
      const all = await this.getAllGroups();
      const ids = Object.keys((all && all.gridVerMap) || {});
      const CHUNK = 30;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        let map = {};
        try {
          const info = await this._cachedInfo(`group:batch:${slice.join(",")}`, () =>
            this.api.getGroupInfo(slice),
          );
          map = (info && info.gridInfoMap) || {};
        } catch (e) {
          console.warn(`[zalo] getGroupInfo chunk failed (${slice.length} ids): ${e.message}`);
        }
        for (const id of slice) {
          const g = map[id] || {};
          groups.push({ id: String(id), name: g.name || g.groupName || `(group ${id})` });
        }
      }
    } catch (e) {
      console.error("[zalo] listContacts groups failed:", e.message);
    }
    // Friends: getAllFriends already returns objects with userId + displayName.
    try {
      const fr = await this.getAllFriends();
      for (const f of Array.isArray(fr) ? fr : []) {
        friends.push({
          id: String(f.userId || f.uid || f.id || ""),
          name: f.displayName || f.zaloName || f.username || "(friend)",
        });
      }
    } catch (e) {
      console.error("[zalo] listContacts friends failed:", e.message);
    }
    return { groups, friends };
  }

  // ── Generic passthrough to any zca-js API method ──────────────────────────
  // Covers the long tail of zca-js APIs without a bespoke wrapper each. Args
  // are passed positionally; any arg equal to the string "user"/"group" is
  // converted to the ThreadType enum (many zca-js methods take a trailing
  // ThreadType). Method names are validated against the live API surface.
  async callRaw(method, args = []) {
    if (typeof method !== "string" || !/^[a-zA-Z]\w*$/.test(method)) {
      throw new Error("invalid method name");
    }
    const fn = this.api && this.api[method];
    if (typeof fn !== "function") {
      throw new Error(`unknown zca-js API method: ${method}`);
    }
    const mapped = (Array.isArray(args) ? args : [args]).map((a) => {
      if (a === "user") return ThreadType.User;
      if (a === "group") return ThreadType.Group;
      return a;
    });
    return await fn.apply(this.api, mapped);
  }

  // ── Lifecycle: relogin after session death, graceful shutdown ─────────────

  /**
   * Recover a dead session by re-running QR login. Stops the old listener,
   * clears state, and starts a fresh login (cookie first, QR fallback).
   * Forces QR when the saved cookie is the thing that died.
   */
  async relogin({ forceQR = true } = {}) {
    try {
      if (this.api && this.api.listener) this.api.listener.stop();
    } catch {
      /* ignore */
    }
    this.api = null;
    this.loggedIn = false;
    return await this.login({ forceQR });
  }

  /** Graceful shutdown: stop listener, close the persistence stream. */
  async shutdown() {
    try {
      if (this.api && this.api.listener) this.api.listener.stop();
    } catch {
      /* ignore */
    }
    try {
      if (this._cliMsgStream) {
        this._cliMsgStream.end();
        this._cliMsgStream = null;
      }
    } catch {
      /* ignore */
    }
    this.loggedIn = false;
    console.log("[zalo] client shut down");
  }
}

export { ThreadType };

# hermes-zalo-bridge

📖 **English** · [Tiếng Việt](./README.vi.md)

[![npm version](https://img.shields.io/npm/v/hermes-zalo-bridge.svg)](https://www.npmjs.com/package/hermes-zalo-bridge)
[![npm downloads](https://img.shields.io/npm/dm/hermes-zalo-bridge.svg)](https://www.npmjs.com/package/hermes-zalo-bridge)
[![GitHub stars](https://img.shields.io/github/stars/cuongdev/hermes-zalo-bridge?style=social)](https://github.com/cuongdev/hermes-zalo-bridge/stargazers)
[![license](https://img.shields.io/npm/l/hermes-zalo-bridge.svg)](./LICENSE)

Node.js bridge connecting **zca-js** (unofficial personal Zalo API) to the
**Hermes Agent** gateway. It lets you chat with your Hermes agent from a
personal Zalo account.

```
Zalo servers ──ws──> [ this bridge (Node + zca-js) ] <──HTTP/SSE──> [ Hermes plugin: platforms/zalo ]
```

- **Inbound** (Zalo → Hermes): Server-Sent Events at `GET /events`
  (heartbeat every 15s + `Last-Event-ID` replay from a ring buffer).
- **Outbound** (Hermes → Zalo): REST `POST /send`, `/send-attachment`,
  `/send-sticker`, `/send-voice`, `/typing`.

> ⚠️ **zca-js is UNOFFICIAL.** Use a secondary Zalo account. Zalo may
> rate-limit or lock accounts that automate. You accept that risk.

## Requirements

Before installing, make sure you have:

| Requirement | Why | How to get it |
|-------------|-----|---------------|
| **Node.js ≥ 18** (with `npm`) | runs the bridge | macOS: `brew install node` · Linux: [nvm](https://github.com/nvm-sh/nvm) or distro `nodejs` · Windows: [nodejs.org](https://nodejs.org) LTS installer. Verify: `node -v` |
| **A Zalo account** (secondary recommended) | the bridge logs in as this account | Zalo mobile app to scan the QR |
| **Hermes Agent installed** | the chat agent that talks to the bridge | the `hermes` CLI on PATH |
| **Python `aiohttp`** | the Hermes-side Zalo adapter uses it for HTTP/SSE | `pip install aiohttp` (the `hermes gateway setup` Zalo flow also reminds you) |

The installer checks Node + npm and stops with a clear message if either is
missing — it won't run half-way and leave you confused. zca-js itself needs **no
build tools** (no `bun`, no compiler); it's pulled prebuilt from npm.

## Quick start (one-time)

Works on **macOS, Linux, and Windows** — Node drives everything; no `bun`, no
build-from-source (zca-js is pulled from npm).

**Prerequisite:** Node.js ≥ 18 ([nodejs.org](https://nodejs.org)).

**Install from npm (recommended):**

```bash
npm install -g hermes-zalo-bridge
hermes-zalo-bridge setup      # QR login + background service
```

**Or from a source checkout:**

```bash
# macOS / Linux
./install.sh

# Windows (PowerShell)
.\install.ps1
```

The setup step:
1. installs dependencies (when run from source),
2. walks you through **QR login** (scan once; credentials are saved to
   `~/.hermes-zalo/`), and
3. installs a **background service** that auto-starts the bridge on login/boot
   and restarts it on crash — launchd (macOS), systemd user unit (Linux), or a
   Scheduled Task (Windows).

CLI commands: `hermes-zalo-bridge setup | login | start | stop | status | uninstall`.

Then register it in Hermes:

```bash
hermes gateway setup     # choose "Zalo" (🇻🇳)
hermes gateway           # start relaying
```

That's it — login + setup are one-time; the bridge stays alive on its own.

### Installer flags

| Flag | Effect |
|------|--------|
| `--no-service` | Install deps + login only; run the bridge yourself with `npm start`. |
| `--relogin` | Force a fresh QR login (e.g. after the session expired). |
| `--service-only` | (Re)install just the background service. |

Remove the background service (credentials kept):

```bash
node uninstall.mjs            # stop + remove auto-start service
node uninstall.mjs --purge    # also delete saved credentials (logout)
```

## Manual install (advanced)

If you'd rather not use the installer:

```bash
npm install                  # pulls zca-js from npm
node login.mjs               # QR login (--force to re-scan)
npm start                    # run the bridge in the foreground
```

You can also fetch the QR while the server runs:
`GET /qr` (JSON with base64 image) or `GET /qr.png` (raw PNG).

## 3. Configuration (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `ZALO_BRIDGE_PORT` | `8787` | Listen port |
| `ZALO_BRIDGE_HOST` | `127.0.0.1` | Bind host (keep loopback unless you add TLS) |
| `ZALO_BRIDGE_TOKEN` | _(none)_ | Shared secret; if set, required on every route (header `x-bridge-token`, `Authorization: Bearer`, or `?token=`) |
| `ZALO_CREDENTIALS_PATH` | `./data/credentials.json` | Where credentials persist |
| `ZALO_QR_PATH` | `./data/qr.png` | Where the QR PNG is written |
| `ZALO_SELF_LISTEN` | off | Receive your own outgoing messages too |
| `ZALO_FORCE_QR` | off | Ignore saved credentials and re-QR |
| `ZALO_CLIMSG_RETENTION_DAYS` | `30` | Days to keep the undo cache (msgId→cliMsgId) on disk under `data/climsgids/` (daily-rotated JSONL, auto-pruned). Reloaded on startup so message recall (undo) survives restarts. `0` disables persistence (memory-only). |
| `ZALO_ALLOWED_ACTION_GROUPS` | `read,send,interact` | Comma-separated permission groups, by danger level: `read` < `send` < `interact` < `manage` < `destructive` (or `all`). Gates BOTH `/api/<method>` and the first-class routes. |
| `ZALO_ALLOW_DESTRUCTIVE` | `false` | Must be `true` to permit the `destructive` group (disperseGroup, deleteMessage, deleteChat, removeFriend, blockUser, leaveGroup, changeGroupOwner, updateProfile/Settings…). OFF even when groups=`all`. |
| `ZALO_ALLOWED_ACTIONS` | _(none)_ | Custom allowlist — comma-separated zca-js method names always permitted regardless of group. |
| `ZALO_DENIED_ACTIONS` | _(none)_ | Custom denylist — comma-separated method names always blocked. Highest precedence (beats allowlist, groups, everything). |

### Access control (action permissions)

The bridge classifies all 145 zca-js actions into 5 groups by danger level and
refuses any action not permitted by the policy with HTTP `403`. Precedence:

1. `ZALO_DENIED_ACTIONS` — always blocked.
2. `ZALO_ALLOWED_ACTIONS` — always allowed.
3. `destructive` group — only if `ZALO_ALLOW_DESTRUCTIVE=true`.
4. `ZALO_ALLOWED_ACTION_GROUPS` — the method's group must be listed.

Group sizes: read 55, send 12, interact 13, manage 39, destructive 26. The full
map lives in `permissions.js` (auto-generated). `GET /policy` returns the live
policy and the resolved allowed-action list.

### Who may talk to the bot (sender / thread / group-mode)

These are **adapter-side** env vars (set where `hermes gateway` runs), Telegram-style
— leave empty to allow everyone/everywhere:

| Var | Default | Effect |
|-----|---------|--------|
| `ZALO_ALLOWED_USERS` | _(empty=all)_ | CSV of sender uids permitted to command the bot. |
| `ZALO_ALLOWED_THREADS` | _(empty=all)_ | CSV of thread/group ids the bot operates in. |
| `ZALO_GROUP_MODE` | `mention` | In groups: `mention` (only when @mentioned or replied-to — detected by real uid, not text guessing), `all` (every message), or `off` (DM only). |
| `ZALO_LOG_IDS` | `false` | Log each inbound `uid`/`threadId` so you can discover ids for the allowlists. |

The setup wizard (`hermes gateway setup` → Zalo) fetches `/contacts` and lets you
**search by name and pick** instead of typing raw ids.

### Info-call rate limiting (anti account-lock)

zca-js is unofficial; hammering `getUserInfo`/`getGroupInfo`/`getAllGroups`/`getAllFriends`
risks a temporary block. The bridge caches these by id with a TTL, serializes
them with a minimum gap, and backs off (serving stale cache) on a suspected
rate-limit:

| Var | Default | Effect |
|-----|---------|--------|
| `ZALO_INFO_CACHE_TTL` | `600` (s) | TTL for cached read-info results. |
| `ZALO_INFO_MIN_INTERVAL_MS` | `1500` | Minimum ms between read-info calls; exponential backoff (cap 5 min) on rate-limit errors. |

## 4. HTTP API

- `GET  /health` → `{ ok, loggedIn, sessionDead, sessionDeadReason, ownId, qr, sseClients }`
- `GET  /qr` / `GET /qr.png` → QR state / PNG
- `GET  /events` → SSE stream (`event: message` / `status` / `session_dead` / `reaction` / `undo` / `friend_event` / `group_event`)
- `POST /relogin` → `{ forceQR? }` recover a dead/expired session (re-run QR login; then poll `/qr.png` to scan)
- `POST /shutdown` → graceful stop (closes listener, SSE, file streams, exits). SIGTERM/SIGINT do the same.
- `POST /send` → `{ threadId, threadType: "user"|"group", text, mentions?, quote? }` (mentions = `[{pos,uid,len}]` for @mention; quote = a SendMessageQuote from an inbound message for replies)
- `POST /react` → `{ threadId, threadType, msgId, cliMsgId?, icon }` (icon = HEART/LIKE/HAHA/WOW/CRY/ANGRY/… or raw)
- `POST /undo` → `{ threadId, threadType, msgId }` (recall own message; bridge auto-resolves the real cliMsgId from the listener echo cache — just pass msgId)
- `POST /send-card` → `{ threadId, threadType, userId, phoneNumber? }` (send a contact card / danh thiếp)
- `POST /friend/request|accept|reject` → `{ userId, msg? }`
- `GET  /friends` → list all friends · `GET /find-user?phone=` → look up by phone
- `GET  /groups` → list all groups (raw `gridVerMap`)
- `GET  /contacts` → `{ groups:[{id,name}], friends:[{id,name}] }` — friendly id+name list for the setup wizard (batched + cached + rate-limited)
- `POST /group/create` `{name, members[]}` · `/group/add` `/group/remove` `/group/rename` `/group/deputy` `{groupId, members[]|name}` · `/group/leave` `{groupId, silent?}`
- `POST /poll/create` → `{ groupId, question, options[], expiredTime?, allowMultiChoices?, allowAddNewOption?, hideVotePreview?, isAnonymous? }`
- `POST /api/<method>` → `{ args: [...] }` — **generic passthrough to ANY zca-js API method** (full 145-API parity). Pass args positionally as zca-js documents; use `"user"`/`"group"` where a ThreadType is needed (auto-converted). Examples: `/api/forwardMessage`, `/api/deleteMessage`, `/api/sendVideo`, `/api/getGroupMembersInfo`, `/api/getGroupChatHistory`, `/api/createReminder`, `/api/setMute`, `/api/votePoll`, `/api/blockUser`, `/api/updateProfile`. Unknown method → error.
- `POST /send-attachment` → `{ threadId, threadType, path | paths[], caption? }` (local file paths; images/files/video auto-routed by extension)
- `POST /send-sticker` → `{ threadId, threadType, sticker: { id, cateId, type } }`
- `GET  /stickers?keyword=hi&limit=5` → search stickers, returns full `{ id, cateId, type, ... }` objects ready to pass to `/send-sticker`
- `POST /send-voice` → `{ threadId, threadType, voiceUrl }`
- `POST /typing` → `{ threadId, threadType }`
- `GET  /chat-info?threadId=..&threadType=user|group`

Inbound `message` event shape:

```json
{
  "messageId": "...", "cliMsgId": "...",
  "threadId": "...", "threadType": "user|group",
  "senderId": "...", "senderName": "...", "text": "...",
  "attachment": null,
  "media": null,                 // {kind,url,fileName,ext,mime,size} for image/voice/file/video
  "msgType": "webchat",
  "mentions": [],                // group only: uids @mentioned in this message
  "quotedOwnerId": "",           // uid of the owner of the quoted msg (set on replies)
  "quote": { "...": "..." },     // raw quote payload to build a reply
  "ts": "...", "isSelf": false
}
```

`mentions` and `quotedOwnerId` are what the adapter uses to detect "the bot was
addressed" in groups (real uid match, not text guessing).

## 5. Wire up the Hermes plugin

The plugin lives at `hermes-agent/plugins/platforms/zalo/`. Two ways to set it up:

### Option A — guided wizard (recommended)

```bash
hermes gateway setup        # choose "Zalo"
```

The wizard asks for the bridge URL/token, then — with the bridge already logged
in — fetches your groups and friends (`GET /contacts`) and lets you **search by
name and pick** which users / threads the bot may talk to, the group response
mode, action permissions, and cache retention. It writes everything to
`~/.hermes/.env`.

### Option B — manual env

```bash
export ZALO_BRIDGE_URL="http://127.0.0.1:8787"
# Access control (Telegram-style: leave empty = allow everyone/everywhere)
# export ZALO_ALLOWED_USERS="<uid1>,<uid2>"      # restrict senders
# export ZALO_ALLOWED_THREADS="<groupId>,<uid>"  # restrict groups/DMs
# export ZALO_GROUP_MODE="mention"               # mention | all | off
pip install aiohttp                               # if not already present
hermes gateway   # the Zalo adapter connects to the bridge and starts relaying
```

Run the bridge first (logged in), then the Hermes gateway.

> ⚠️ `ZALO_ALLOW_ALL_USERS` and `ZALO_GROUP_REQUIRE_MENTION` are DEPRECATED.
> Leave `ZALO_ALLOWED_USERS` empty to allow everyone; use `ZALO_GROUP_MODE`
> instead of the old mention flag.

## 6. Everyday use

- **Chat 1-1:** message the Zalo account from another phone → the agent replies
  (subject to `ZALO_ALLOWED_USERS`).
- **In a group:** by default (`ZALO_GROUP_MODE=mention`) the bot only answers when
  @mentioned or when someone replies to one of its messages. Set `all` to answer
  every message, or `off` to ignore groups.
- **Find an ID later:** set `ZALO_LOG_IDS=true`, send a message, and read the
  `uid=… threadId=…` line in the gateway log; add it to the allowlist.
- **Change who/what is allowed:** edit the `ZALO_*` vars in `~/.hermes/.env`
  (adapter-side: users/threads/mode) or the bridge's env (action permissions,
  rate-limit), then restart the gateway / bridge.
- **Send media / stickers / reactions / polls:** the agent calls the bridge
  routes above; everything in the 145-API surface is reachable via
  `POST /api/<method>` subject to the action-permission policy.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `/health` shows `loggedIn:false` | Session not established — run `ZALO_FORCE_QR=1 node server.js` and scan, or `POST /relogin`. |
| `/health` shows `sessionDead:true` | Logged in elsewhere / kicked / cookie expired. `POST /relogin {forceQR:true}` and re-scan. |
| Action returns HTTP 403 | Blocked by the action policy — check `GET /policy`; widen `ZALO_ALLOWED_ACTION_GROUPS` or set `ZALO_ALLOW_DESTRUCTIVE=true` / `ZALO_ALLOWED_ACTIONS`. |
| Bot ignores group messages | `ZALO_GROUP_MODE=mention` and you didn't @mention/reply; or the thread isn't in `ZALO_ALLOWED_THREADS`. |
| "Zalo info calls are backing off" | Rate-limit hit; the bridge is self-throttling. Wait, or raise `ZALO_INFO_CACHE_TTL` to lean on cache. |
| `getGroupInfo` returns empty | Must be called with an ARRAY of ids; a single string returns nothing. |
| No realtime logs | Node buffers stdout off-TTY — run with `stdbuf -oL -eL node server.js \| tee data/bridge.log`. |

## Running as a background service

The installer already sets this up (launchd / systemd / Scheduled Task) so the
bridge auto-starts and restarts on crash. If you used `--no-service`, run
`node install.mjs --service-only` to add it later, or just `npm start` to run it
in the foreground. The bridge auto-reconnects the Zalo websocket (zca-js
`retryOnClose`); the Hermes adapter auto-reconnects the SSE stream with backoff +
`Last-Event-ID` replay.

## Publishing (maintainers)

CI runs on every push/PR (syntax + CLI smoke + pack-safety on Node 18/20/22
across macOS/Linux/Windows). Publishing uses **npm Trusted Publishing (OIDC)** —
no long-lived `NPM_TOKEN` to store or leak.

**One-time bootstrap** (npm requires the package to exist before you can enable
trusted publishing for it):

1. Publish the first version manually:
   ```bash
   npm login
   npm publish --access public
   ```
2. On npmjs.com → your package → **Settings → Trusted Publisher → GitHub
   Actions**, set:
   - Organization/user: `cuongdev`
   - Repository: `hermes-zalo-bridge`
   - Workflow filename: `publish.yml`

**After that**, releases are automatic and tokenless:

```bash
npm version patch        # bumps package.json + creates a git tag
git push --follow-tags   # the v* tag triggers publish.yml (OIDC publish)
```

The workflow runs on Node 24 / npm latest (Trusted Publishing needs npm ≥ 11.5.1)
and publishes with `--provenance`, so each release is cryptographically attested
to this repo and workflow.

## License

MIT © [Cường Tuấn Nguyễn](https://github.com/cuongdev)

## Star History

If this saved you time, a ⭐ helps others find it —
[**view the star history chart**](https://star-history.com/#cuongdev/hermes-zalo-bridge&Date).

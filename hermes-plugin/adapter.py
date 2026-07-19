"""
Zalo Platform Adapter for Hermes Agent.

Bridges to a companion Node.js process (hermes-zalo-plugin) that runs
zca-js (the unofficial Zalo personal API). Communication:

    inbound  : SSE stream  GET  {bridge}/events   (Zalo -> Hermes)
    outbound : REST        POST {bridge}/send, /send-attachment, ...

Configuration in config.yaml::

    gateway:
      platforms:
        zalo:
          enabled: true
          extra:
            bridge_url: "http://127.0.0.1:8787"
            bridge_token: ""              # optional shared secret
            allowed_users: []             # empty = allow all (with allow_all), or list of uidFrom
            allow_all_users: false
            group_require_mention: true   # only reply in groups when addressed
            max_message_length: 4000

Or via environment variables (override config.yaml):
    ZALO_PLUGIN_URL, ZALO_PLUGIN_TOKEN, ZALO_ALLOWED_USERS,
    ZALO_ALLOW_ALL_USERS, ZALO_HOME_CHANNEL, ZALO_GROUP_REQUIRE_MENTION
"""

import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ── zca-js action → permission-group map (KEEP IN SYNC WITH permissions.js) ──
# Mirrors ACTION_GROUP in the bridge's permissions.js (145 APIs). Bundled
# statically so `hermes gateway setup` can offer a custom action picker even
# when the bridge is offline. If permissions.js changes, regenerate this.
_ACTION_GROUP = {
    "acceptFriendRequest": "manage",
    "addGroupBlockedMember": "destructive",
    "addGroupDeputy": "manage",
    "addPollOptions": "interact",
    "addQuickMessage": "manage",
    "addReaction": "interact",
    "addUnreadMark": "manage",
    "addUserToGroup": "manage",
    "blockUser": "destructive",
    "blockViewFeed": "destructive",
    "changeAccountAvatar": "destructive",
    "changeFriendAlias": "manage",
    "changeGroupAvatar": "manage",
    "changeGroupName": "manage",
    "changeGroupOwner": "destructive",
    "createAutoReply": "manage",
    "createCatalog": "manage",
    "createGroup": "manage",
    "createNote": "interact",
    "createPoll": "interact",
    "createProductCatalog": "manage",
    "createReminder": "interact",
    "deleteAutoReply": "destructive",
    "deleteAvatar": "destructive",
    "deleteCatalog": "destructive",
    "deleteChat": "destructive",
    "deleteGroupInviteBox": "destructive",
    "deleteMessage": "destructive",
    "deleteProductCatalog": "destructive",
    "disableGroupLink": "destructive",
    "disperseGroup": "destructive",
    "editNote": "interact",
    "editReminder": "interact",
    "enableGroupLink": "manage",
    "fetchAccountInfo": "read",
    "findUser": "read",
    "findUserByUsername": "read",
    "forwardMessage": "send",
    "getAliasList": "read",
    "getAllFriends": "read",
    "getAllGroups": "read",
    "getArchivedChatList": "read",
    "getAutoDeleteChat": "read",
    "getAutoReplyList": "read",
    "getAvatarList": "read",
    "getAvatarUrlProfile": "read",
    "getBizAccount": "read",
    "getCatalogList": "read",
    "getCloseFriends": "read",
    "getContext": "read",
    "getCookie": "read",
    "getFriendBoardList": "read",
    "getFriendOnlines": "read",
    "getFriendRecommendations": "read",
    "getFriendRequestStatus": "read",
    "getFullAvatar": "read",
    "getGroupBlockedMember": "read",
    "getGroupChatHistory": "read",
    "getGroupInfo": "read",
    "getGroupInviteBoxInfo": "read",
    "getGroupInviteBoxList": "read",
    "getGroupLinkDetail": "read",
    "getGroupLinkInfo": "read",
    "getGroupMembersInfo": "read",
    "getHiddenConversations": "read",
    "getLabels": "read",
    "getListBoard": "read",
    "getListReminder": "read",
    "getMultiUsersByPhones": "read",
    "getMute": "read",
    "getOwnId": "read",
    "getPendingGroupMembers": "read",
    "getPinConversations": "read",
    "getPollDetail": "read",
    "getProductCatalogList": "read",
    "getQR": "read",
    "getQuickMessageList": "read",
    "getRelatedFriendGroup": "read",
    "getReminder": "read",
    "getReminderResponses": "read",
    "getSentFriendRequest": "read",
    "getSettings": "read",
    "getStickerCategoryDetail": "read",
    "getStickers": "read",
    "getStickersDetail": "read",
    "getUnreadMark": "read",
    "getUserInfo": "read",
    "inviteUserToGroups": "manage",
    "joinGroupInviteBox": "manage",
    "joinGroupLink": "manage",
    "keepAlive": "read",
    "lastOnline": "read",
    "leaveGroup": "destructive",
    "lockPoll": "interact",
    "parseLink": "send",
    "rejectFriendRequest": "manage",
    "removeFriend": "destructive",
    "removeFriendAlias": "manage",
    "removeGroupBlockedMember": "manage",
    "removeGroupDeputy": "manage",
    "removeQuickMessage": "destructive",
    "removeReminder": "destructive",
    "removeUnreadMark": "manage",
    "removeUserFromGroup": "destructive",
    "resetHiddenConversPin": "destructive",
    "reuseAvatar": "manage",
    "reviewPendingMemberRequest": "manage",
    "searchSticker": "read",
    "sendBankCard": "send",
    "sendCard": "send",
    "sendDeliveredEvent": "interact",
    "sendFriendRequest": "manage",
    "sendLink": "send",
    "sendMessage": "send",
    "sendReport": "send",
    "sendSeenEvent": "interact",
    "sendSticker": "send",
    "sendTypingEvent": "send",
    "sendVideo": "send",
    "sendVoice": "send",
    "setHiddenConversations": "manage",
    "setMute": "manage",
    "setPinnedConversations": "manage",
    "sharePoll": "interact",
    "unblockUser": "manage",
    "undo": "interact",
    "undoFriendRequest": "manage",
    "updateActiveStatus": "manage",
    "updateArchivedChatList": "manage",
    "updateAutoDeleteChat": "manage",
    "updateAutoReply": "manage",
    "updateCatalog": "manage",
    "updateGroupSettings": "manage",
    "updateHiddenConversPin": "destructive",
    "updateLabels": "manage",
    "updateLang": "destructive",
    "updateProductCatalog": "manage",
    "updateProfile": "destructive",
    "updateProfileBio": "destructive",
    "updateQuickMessage": "manage",
    "updateSettings": "destructive",
    "upgradeGroupToCommunity": "destructive",
    "uploadAttachment": "send",
    "uploadProductPhoto": "manage",
    "votePoll": "interact",
}

from gateway.platforms.base import (
    BasePlatformAdapter,
    SendResult,
    MessageEvent,
    MessageType,
    cache_image_from_bytes,
    cache_audio_from_bytes,
    cache_document_from_bytes,
)
from gateway.config import Platform


def _truthy(v) -> bool:
    return str(v if v is not None else "").strip().lower() in {"1", "true", "yes", "on"}


def _parse_home_channel(raw: str) -> tuple[str, str]:
    """Parse ZALO_HOME_CHANNEL into (chat_id, thread_type).

    Accepts ``<threadId>`` (defaults to user) or ``<type>:<threadId>``
    where type is ``user`` or ``group``.
    """
    raw = str(raw or "").strip()
    if not raw:
        return "", "user"
    if ":" in raw:
        prefix, _, rest = raw.partition(":")
        prefix = prefix.strip().lower()
        if prefix in {"user", "group"}:
            return rest.strip(), prefix
    return raw, "user"


class ZaloAdapter(BasePlatformAdapter):
    """Zalo adapter that talks to a zca-js bridge over HTTP/SSE."""

    def __init__(self, config, **kwargs):
        platform = Platform("zalo")
        super().__init__(config=config, platform=platform)

        extra = getattr(config, "extra", {}) or {}

        self.bridge_url = (
            os.getenv("ZALO_PLUGIN_URL") or extra.get("bridge_url", "http://127.0.0.1:8787")
        ).rstrip("/")
        self.bridge_token = os.getenv("ZALO_PLUGIN_TOKEN") or extra.get("bridge_token", "")

        # ── Access control (Telegram-style: empty list = allow everyone) ──────
        # A) ALLOWED_USERS  — uids permitted to command the bot. Empty = all.
        # B) ALLOWED_THREADS — thread/group ids the bot operates in. Empty = all.
        # C) GROUP_MODE     — in groups: "mention" (default) | "all" | "off".
        def _csv_env(name, fallback_key):
            raw = os.getenv(name)
            if raw is not None:
                return [x.strip() for x in raw.split(",") if x.strip()]
            return [str(x).strip() for x in (extra.get(fallback_key, []) or []) if str(x).strip()]

        self.allowed_users = _csv_env("ZALO_ALLOWED_USERS", "allowed_users")
        self._allowed_users = {str(u) for u in self.allowed_users}
        self.allowed_threads = _csv_env("ZALO_ALLOWED_THREADS", "allowed_threads")
        self._allowed_threads = {str(t) for t in self.allowed_threads}

        # Group response mode. Back-compat: legacy ZALO_GROUP_REQUIRE_MENTION=false
        # maps to "all"; true/unset maps to "mention".
        mode = (os.getenv("ZALO_GROUP_MODE") or extra.get("group_mode") or "").strip().lower()
        if not mode:
            legacy = os.getenv("ZALO_GROUP_REQUIRE_MENTION")
            if legacy is not None and not _truthy(legacy):
                mode = "all"
            elif extra.get("group_require_mention") is False:
                mode = "all"
            else:
                mode = "mention"
        if mode not in {"mention", "all", "off"}:
            mode = "mention"
        self.group_mode = mode

        # Deprecated flag: warn but honor (allow_all_users=true had no real effect
        # beyond the old confusing gate; empty allowlist already means "all").
        if os.getenv("ZALO_ALLOW_ALL_USERS") is not None or extra.get("allow_all_users") is not None:
            logger.warning(
                "Zalo: ZALO_ALLOW_ALL_USERS is deprecated and ignored. "
                "Leave ZALO_ALLOWED_USERS empty to allow everyone, or list specific uids."
            )

        # Log inbound uid/threadId to help operators discover ids for allowlists.
        self.log_ids = _truthy(os.getenv("ZALO_LOG_IDS")) if os.getenv("ZALO_LOG_IDS") else bool(extra.get("log_ids", False))

        max_msg = extra.get("max_message_length")
        self.max_message_length = int(max_msg or 4000)

        self._own_id: Optional[str] = None
        self._own_name: Optional[str] = None
        # Remember the thread type per chat_id from inbound messages so replies
        # route correctly (user vs group). Zalo thread IDs don't encode type.
        self._thread_types: Dict[str, str] = {}
        self._policy: Optional[Dict[str, Any]] = None

        self._session = None  # aiohttp.ClientSession
        self._sse_task: Optional[asyncio.Task] = None
        self._stop = False
        self._last_event_id = 0

    @property
    def name(self) -> str:
        return "Zalo"

    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.bridge_token:
            h["x-bridge-token"] = self.bridge_token
        return h

    # ── Connection lifecycle ──────────────────────────────────────────────

    async def connect(self) -> bool:
        if not self.bridge_url:
            self._set_fatal_error("config_missing", "ZALO_PLUGIN_URL must be set", retryable=False)
            return False
        try:
            import aiohttp  # noqa
        except ImportError:
            self._set_fatal_error(
                "dependency_missing",
                "aiohttp is required for the Zalo adapter (pip install aiohttp)",
                retryable=False,
            )
            return False

        import aiohttp

        self._stop = False
        self._session = aiohttp.ClientSession()

        # Probe bridge health and login state.
        try:
            async with self._session.get(
                f"{self.bridge_url}/health",
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()
        except Exception as e:
            logger.error("Zalo: cannot reach bridge at %s — %s", self.bridge_url, e)
            await self._close_session()
            self._set_fatal_error("bridge_unreachable", f"Bridge unreachable: {e}", retryable=True)
            return False

        if not data.get("loggedIn"):
            qr = data.get("qr")
            msg = (
                "Zalo plugin is running but not logged in. "
                f"Scan the QR (bridge state: {qr}). See {self.bridge_url}/qr.png"
            )
            logger.error("Zalo: %s", msg)
            await self._close_session()
            self._set_fatal_error("not_logged_in", msg, retryable=True)
            return False

        self._own_id = str(data.get("ownId") or "") or None

        # Fetch + log the active action policy (transparency; helps the agent
        # understand what it can/can't do without hitting 403 blindly).
        try:
            async with self._session.get(
                f"{self.bridge_url}/policy", timeout=aiohttp.ClientTimeout(total=10)
            ) as presp:
                policy = await presp.json()
            self._policy = policy
            logger.info(
                "Zalo: action policy groups=%s destructive=%s allowed=%s/%s",
                policy.get("groups"),
                policy.get("allowDestructive"),
                policy.get("allowedActionCount"),
                policy.get("totalActions"),
            )
        except Exception as e:
            self._policy = None
            logger.warning("Zalo: could not fetch action policy: %s", e)

        # Start the SSE inbound loop.
        self._sse_task = asyncio.create_task(self._sse_loop())
        self._mark_connected()
        logger.info("Zalo: connected to bridge %s (ownId=%s)", self.bridge_url, self._own_id)
        return True

    async def disconnect(self) -> None:
        self._stop = True
        self._mark_disconnected()
        if self._sse_task and not self._sse_task.done():
            self._sse_task.cancel()
            try:
                await self._sse_task
            except asyncio.CancelledError:
                pass
        await self._close_session()

    async def _close_session(self) -> None:
        if self._session and not self._session.closed:
            try:
                await self._session.close()
            except Exception:
                pass
        self._session = None

    # ── Inbound: SSE loop ─────────────────────────────────────────────────

    async def _sse_loop(self) -> None:
        """Consume the bridge SSE stream with reconnect + backoff."""
        import aiohttp

        backoff = 1.0
        while not self._stop:
            try:
                headers = {}
                if self.bridge_token:
                    headers["x-bridge-token"] = self.bridge_token
                if self._last_event_id:
                    headers["Last-Event-ID"] = str(self._last_event_id)

                timeout = aiohttp.ClientTimeout(total=None, sock_read=None)
                async with self._session.get(
                    f"{self.bridge_url}/events", headers=headers, timeout=timeout
                ) as resp:
                    if resp.status != 200:
                        raise RuntimeError(f"SSE status {resp.status}")
                    backoff = 1.0  # reset after a successful connect
                    await self._consume_sse(resp)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self._stop:
                    break
                logger.warning("Zalo: SSE disconnected (%s); reconnecting in %.1fs", e, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _consume_sse(self, resp) -> None:
        event_type = "message"
        data_lines: List[str] = []
        event_id: Optional[int] = None

        async for raw_line in resp.content:
            if self._stop:
                return
            line = raw_line.decode("utf-8", errors="replace").rstrip("\n").rstrip("\r")

            if line == "":
                # Dispatch the accumulated event.
                if data_lines:
                    payload = "\n".join(data_lines)
                    await self._handle_sse_event(event_type, payload)
                    if event_id is not None:
                        self._last_event_id = event_id
                event_type = "message"
                data_lines = []
                event_id = None
                continue

            if line.startswith(":"):
                continue  # heartbeat / comment
            if line.startswith("event:"):
                event_type = line[len("event:"):].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:"):].lstrip())
            elif line.startswith("id:"):
                try:
                    event_id = int(line[len("id:"):].strip())
                except ValueError:
                    event_id = None
            elif line.startswith("retry:"):
                pass

    async def _handle_sse_event(self, event_type: str, payload: str) -> None:
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return

        if event_type == "status":
            logger.info("Zalo: bridge status %s", data)
            return
        if event_type == "session_dead":
            await self._on_session_dead(data)
            return
        if event_type == "message":
            await self._on_inbound_message(data)
            return
        # Reaction / undo / friend / group events: surface as a synthetic
        # context line for the agent (no media). These don't trigger a turn by
        # default unless a handler wants them; we log + optionally dispatch.
        if event_type in ("reaction", "undo", "friend_event", "group_event"):
            logger.info("Zalo: %s event %s", event_type, data)
            return

    async def _on_session_dead(self, data: Dict[str, Any]) -> None:
        """Zalo session ended (logout / kicked / cookie expired)."""
        msg = (data or {}).get("message") or "Zalo session ended."
        code = (data or {}).get("code")
        logger.error("Zalo: SESSION DEAD (code=%s): %s", code, msg)
        # Mark fatal so `hermes gateway status` shows Zalo as down and the
        # gateway can surface/heal it.
        self._set_fatal_error(
            "session_dead",
            f"{msg} Re-scan the QR (POST {self.bridge_url}/relogin then open "
            f"{self.bridge_url}/qr.png) to recover.",
            retryable=True,
        )
        try:
            await self._notify_fatal_error()
        except Exception:
            pass
        # Best-effort: notify the operator in their home channel if known.
        home = os.getenv("ZALO_HOME_CHANNEL")
        if home and self._message_handler:
            chat_id, ttype = _parse_home_channel(home)
            if chat_id:
                try:
                    src = self.build_source(
                        chat_id=chat_id,
                        chat_name=chat_id,
                        chat_type="group" if ttype == "group" else "dm",
                        user_id=self._own_id or "system",
                        user_name="Zalo",
                    )
                    ev = MessageEvent(
                        text=(
                            "⚠️ Zalo session đã hết hạn / bị đăng xuất. "
                            f"({msg}) Cần quét lại QR để khôi phục: "
                            f"POST {self.bridge_url}/relogin rồi mở {self.bridge_url}/qr.png"
                        ),
                        message_type=MessageType.TEXT,
                        source=src,
                        internal=True,
                        timestamp=datetime.now(),
                    )
                    await self.handle_message(ev)
                except Exception:
                    pass

    async def _on_inbound_message(self, m: Dict[str, Any]) -> None:
        if not self._message_handler:
            return
        if m.get("isSelf"):
            return

        thread_id = str(m.get("threadId") or "")
        thread_type = m.get("threadType") or "user"  # "user" | "group"
        sender_id = str(m.get("senderId") or "")
        sender_name = m.get("senderName") or ""
        text = m.get("text") or ""
        chat_type = "group" if thread_type == "group" else "dm"

        # Remember type for outbound routing.
        self._thread_types[thread_id] = "group" if thread_type == "group" else "user"

        # ── Access control (Telegram-style) ──────────────────────────────────
        # Optionally log ids so the operator can build allowlists.
        if self.log_ids:
            logger.info(
                "Zalo inbound: uid=%s name=%r threadId=%s type=%s",
                sender_id, sender_name, thread_id, chat_type,
            )

        # B) Thread/group allowlist — empty = everywhere.
        if self._allowed_threads and thread_id not in self._allowed_threads:
            logger.debug("Zalo: ignoring message in non-allowed thread %s", thread_id)
            return

        # A) Sender allowlist — empty = everyone.
        if self._allowed_users and sender_id not in self._allowed_users:
            logger.debug("Zalo: ignoring message from non-allowed user %s", sender_id)
            return

        # C) Group response mode: off / mention / all.
        if chat_type == "group":
            if self.group_mode == "off":
                return
            if self.group_mode == "mention":
                addressed = self._is_addressed(m, text)
                if not addressed:
                    return
                text = addressed
            # group_mode == "all" → respond to everything (subject to A+B above)

        source = self.build_source(
            chat_id=thread_id,
            chat_name=sender_name if chat_type == "dm" else thread_id,
            chat_type=chat_type,
            user_id=sender_id,
            user_name=sender_name,
        )

        # Download inbound media so the agent can see/hear it.
        media_urls: List[str] = []
        media_types: List[str] = []
        message_type = MessageType.TEXT
        media = m.get("media")
        if isinstance(media, dict) and media.get("url"):
            local_path, mtype = await self._download_media(media)
            if local_path:
                media_urls.append(local_path)
                media_types.append(media.get("mime") or "")
                message_type = mtype

        event = MessageEvent(
            text=text,
            message_type=message_type,
            source=source,
            message_id=str(m.get("messageId") or ""),
            raw_message=m,
            media_urls=media_urls,
            media_types=media_types,
            timestamp=datetime.now(),
        )
        await self.handle_message(event)

    async def _download_media(self, media: Dict[str, Any]) -> tuple[Optional[str], "MessageType"]:
        """Download a media URL to the Hermes cache. Returns (path, MessageType)."""
        import aiohttp

        url = media.get("url")
        kind = media.get("kind") or "other"
        ext = (media.get("ext") or "bin").lstrip(".")
        file_name = media.get("fileName") or f"zalo.{ext}"
        if not url or not self._session or self._session.closed:
            return None, MessageType.TEXT
        try:
            async with self._session.get(
                url, timeout=aiohttp.ClientTimeout(total=120)
            ) as resp:
                if resp.status != 200:
                    logger.warning("Zalo: media download failed (%s) for %s", resp.status, kind)
                    return None, MessageType.TEXT
                data = await resp.read()
        except Exception as e:
            logger.warning("Zalo: media download error for %s: %s", kind, e)
            return None, MessageType.TEXT

        try:
            if kind == "image":
                return cache_image_from_bytes(data, ext="." + ext), MessageType.PHOTO
            if kind == "voice":
                return cache_audio_from_bytes(data, ext="." + ext), MessageType.VOICE
            if kind == "video":
                return cache_document_from_bytes(data, file_name), MessageType.VIDEO
            # file and anything else → document
            return cache_document_from_bytes(data, file_name), MessageType.DOCUMENT
        except Exception as e:
            logger.warning("Zalo: failed to cache media (%s): %s", kind, e)
            return None, MessageType.TEXT

    def _is_addressed(self, m: Dict[str, Any], text: str) -> Optional[str]:
        """Return the (possibly stripped) text if the bot is addressed, else None.

        Detection priority (strongest → weakest):
        1. Real @mention: bridge forwards mentions[] (uids); if our ownId is in
           it, we're mentioned. Strip the leading bot-name token if present.
        2. Reply-to-bot: bridge forwards quotedOwnerId; if it equals ownId, the
           user replied to one of our messages.
        3. Text heuristic fallback: message starts with the bot name / a known
           trigger word (used when we don't have uid signals).
        """
        # 1) Real mention by uid.
        mentions = m.get("mentions") or []
        if self._own_id and str(self._own_id) in {str(x) for x in mentions}:
            return self._strip_leading_name(text) or text

        # 2) Reply to one of the bot's messages.
        if self._own_id and str(m.get("quotedOwnerId") or "") == str(self._own_id):
            return text or " "

        # 3) Text heuristic fallback (no reliable uid signal).
        return self._strip_leading_name(text)

    def _strip_leading_name(self, text: str) -> Optional[str]:
        """If text starts with the bot name / a trigger, strip it and return the
        remainder; else None."""
        t = (text or "").strip()
        if not t:
            return None
        candidates = []
        if self._own_name:
            candidates.append(self._own_name)
        candidates += ["hermes", "@hermes", "bot"]
        low = t.lower()
        for c in candidates:
            cl = c.lower()
            if low.startswith(cl):
                return t[len(c):].lstrip(" :,@").strip() or t
            if low.startswith("@" + cl):
                return t[len(c) + 1:].lstrip(" :,@").strip() or t
        return None

    # ── Outbound ──────────────────────────────────────────────────────────

    def _thread_type_for(self, source_or_meta) -> str:
        """Resolve thread type ('user'|'group') from a SessionSource."""
        chat_type = getattr(source_or_meta, "chat_type", None)
        if chat_type == "group":
            return "group"
        return "user"

    async def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        import aiohttp

        if not self._session or self._session.closed:
            return {"error": "no session"}
        try:
            async with self._session.post(
                f"{self.bridge_url}{path}",
                data=json.dumps(body),
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                return await resp.json()
        except Exception as e:
            return {"error": str(e)}

    def _thread_type_from_chat_id(self, chat_id: str, metadata: Optional[Dict[str, Any]]) -> str:
        if metadata and metadata.get("thread_type") in {"user", "group"}:
            return metadata["thread_type"]
        # Use the type remembered from inbound messages for this chat.
        remembered = self._thread_types.get(str(chat_id))
        if remembered in {"user", "group"}:
            return remembered
        return "user"

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        thread_type = self._thread_type_from_chat_id(chat_id, metadata)
        # Split long messages.
        chunks = self.truncate_message(content, max_length=self.max_message_length)
        last = None
        for chunk in chunks:
            if not chunk.strip():
                continue
            res = await self._post(
                "/send",
                {"threadId": chat_id, "threadType": thread_type, "text": chunk},
            )
            if res.get("error"):
                return SendResult(success=False, error=res["error"])
            last = res
            await asyncio.sleep(0.2)
        msg_id = None
        if isinstance(last, dict):
            result = last.get("result")
            if isinstance(result, dict):
                # zca-js returns { message: { msgId }, attachment: [...] }
                msg = result.get("message")
                if isinstance(msg, dict) and msg.get("msgId") is not None:
                    msg_id = str(msg.get("msgId"))
                elif result.get("msgId") is not None:
                    msg_id = str(result.get("msgId"))
        return SendResult(success=True, message_id=msg_id)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        thread_type = self._thread_type_from_chat_id(chat_id, metadata)
        await self._post("/typing", {"threadId": chat_id, "threadType": thread_type})

    async def send_image(self, chat_id, image_url, caption=None, reply_to=None, metadata=None):
        return await self.send_image_file(chat_id, image_url, caption, reply_to, metadata)

    async def send_image_file(self, chat_id, image_path, caption=None, reply_to=None, metadata=None, **kwargs):
        thread_type = self._thread_type_from_chat_id(chat_id, metadata)
        res = await self._post(
            "/send-attachment",
            {"threadId": chat_id, "threadType": thread_type, "path": image_path, "caption": caption or ""},
        )
        if res.get("error"):
            return SendResult(success=False, error=res["error"])
        return SendResult(success=True)

    async def send_document(self, chat_id, file_path, caption=None, file_name=None, reply_to=None, metadata=None, **kwargs):
        thread_type = self._thread_type_from_chat_id(chat_id, metadata)
        res = await self._post(
            "/send-attachment",
            {"threadId": chat_id, "threadType": thread_type, "path": file_path, "caption": caption or ""},
        )
        if res.get("error"):
            return SendResult(success=False, error=res["error"])
        return SendResult(success=True)

    async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
        return await self.send_document(chat_id, video_path, caption=caption, metadata=metadata)

    async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
        thread_type = self._thread_type_from_chat_id(chat_id, metadata)
        if str(audio_path).startswith(("http://", "https://")):
            # A public m4a URL → real voice bubble via zca-js sendVoice.
            res = await self._post(
                "/send-voice",
                {"threadId": chat_id, "threadType": thread_type, "voiceUrl": audio_path},
            )
            if not res.get("error"):
                return SendResult(success=True)
        # Local audio file (or voiceUrl failed) → send as a playable file
        # attachment. zca-js sendVoice can't reliably HEAD the upload URL, so
        # we don't force a voice bubble for local files.
        res2 = await self._post(
            "/send-attachment",
            {"threadId": chat_id, "threadType": thread_type, "path": audio_path},
        )
        if res2.get("error"):
            return SendResult(success=False, error=res2["error"])
        return SendResult(success=True)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": str(chat_id), "type": "dm", "chat_id": str(chat_id)}

    # ── Extended Zalo actions (for agent tools / direct use) ────────────────

    async def react(self, chat_id, msg_id, icon="HEART", cli_msg_id=None, thread_type=None):
        """React to a message. icon = HEART/LIKE/HAHA/WOW/CRY/ANGRY/… or raw."""
        tt = thread_type or self._thread_types.get(str(chat_id), "user")
        return await self._post("/react", {
            "threadId": chat_id, "threadType": tt,
            "msgId": str(msg_id), "cliMsgId": str(cli_msg_id or msg_id), "icon": icon,
        })

    async def undo(self, chat_id, msg_id, cli_msg_id=None, thread_type=None):
        """Recall/undo one of our own messages."""
        tt = thread_type or self._thread_types.get(str(chat_id), "user")
        return await self._post("/undo", {
            "threadId": chat_id, "threadType": tt,
            "msgId": str(msg_id), "cliMsgId": str(cli_msg_id or msg_id),
        })

    async def reply(self, chat_id, text, quote, thread_type=None):
        """Send a text reply quoting a prior message (quote = SendMessageQuote)."""
        tt = thread_type or self._thread_types.get(str(chat_id), "user")
        return await self._post("/send", {
            "threadId": chat_id, "threadType": tt, "text": text, "quote": quote,
        })

    async def mention(self, chat_id, text, mentions, thread_type="group"):
        """Send a group message with @mentions = [{pos, uid, len}, …]."""
        return await self._post("/send", {
            "threadId": chat_id, "threadType": thread_type, "text": text, "mentions": mentions,
        })

    async def send_card(self, chat_id, user_id, phone_number=None, thread_type=None):
        tt = thread_type or self._thread_types.get(str(chat_id), "user")
        body = {"threadId": chat_id, "threadType": tt, "userId": str(user_id)}
        if phone_number:
            body["phoneNumber"] = str(phone_number)
        return await self._post("/send-card", body)

    # Friends
    async def friend_request(self, user_id, msg=None):
        return await self._post("/friend/request", {"userId": str(user_id), "msg": msg or "Xin chào"})

    async def friend_accept(self, user_id):
        return await self._post("/friend/accept", {"userId": str(user_id)})

    async def friend_reject(self, user_id):
        return await self._post("/friend/reject", {"userId": str(user_id)})

    async def list_friends(self):
        return await self._get("/friends")

    async def find_user(self, phone):
        return await self._get("/find-user", params={"phone": str(phone)})

    # Groups
    async def list_groups(self):
        return await self._get("/groups")

    async def group_create(self, name, members):
        return await self._post("/group/create", {"name": name, "members": [str(x) for x in members]})

    async def group_add(self, group_id, members):
        return await self._post("/group/add", {"groupId": str(group_id), "members": [str(x) for x in members]})

    async def group_remove(self, group_id, members):
        return await self._post("/group/remove", {"groupId": str(group_id), "members": [str(x) for x in members]})

    async def group_rename(self, group_id, name):
        return await self._post("/group/rename", {"groupId": str(group_id), "name": str(name)})

    async def group_deputy(self, group_id, members):
        return await self._post("/group/deputy", {"groupId": str(group_id), "members": [str(x) for x in members]})

    async def group_leave(self, group_id, silent=False):
        return await self._post("/group/leave", {"groupId": str(group_id), "silent": bool(silent)})

    # Poll
    async def poll_create(self, group_id, question, options, **extra):
        body = {"groupId": str(group_id), "question": str(question), "options": [str(o) for o in options]}
        body.update(extra)
        return await self._post("/poll/create", body)

    async def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        import aiohttp
        if not self._session or self._session.closed:
            return {"error": "no session"}
        try:
            async with self._session.get(
                f"{self.bridge_url}{path}",
                params=params or {},
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                return await resp.json()
        except Exception as e:
            return {"error": str(e)}

    async def call(self, method: str, *args) -> Dict[str, Any]:
        """Call ANY zca-js API method through the bridge passthrough.

        Covers the full zca-js surface beyond the first-class helpers above —
        forwardMessage, deleteMessage, sendVideo, sendLink, getGroupMembersInfo,
        getGroupChatHistory, createReminder, setMute, setPinnedConversations,
        block/unblock, votePoll, profile/settings, business catalog, etc.

        Pass args positionally exactly as zca-js documents them. Where a method
        takes a ThreadType, pass the string "user" or "group" (auto-converted).

        Example:
            await adapter.call("deleteMessage", {"data": {...}, "threadId": tid, "type": "user"})
            await adapter.call("getGroupMembersInfo", ["<uid1>", "<uid2>"])
            await adapter.call("setMute", {}, chat_id, "user")
        """
        return await self._post(f"/api/{method}", {"args": list(args)})


# ---------------------------------------------------------------------------
# Plugin registration
# ---------------------------------------------------------------------------

def check_requirements() -> bool:
    """Zalo needs a bridge URL and aiohttp."""
    try:
        import aiohttp  # noqa
    except ImportError:
        return False
    return bool(os.getenv("ZALO_PLUGIN_URL"))


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool(os.getenv("ZALO_PLUGIN_URL") or extra.get("bridge_url"))


def _env_enablement() -> Optional[dict]:
    """Seed PlatformConfig.extra from env so env-only setups show in status."""
    bridge_url = os.getenv("ZALO_PLUGIN_URL")
    if not bridge_url:
        return None
    extra = {
        "bridge_url": bridge_url.rstrip("/"),
        "bridge_token": os.getenv("ZALO_PLUGIN_TOKEN", ""),
    }
    result: Dict[str, Any] = {"extra": extra}
    home = os.getenv("ZALO_HOME_CHANNEL")
    if home:
        chat_id, thread_type = _parse_home_channel(home)
        if chat_id:
            result["home_channel"] = {"chat_id": chat_id, "chat_type": "group" if thread_type == "group" else "dm"}
    return result


def _probe_health(bridge_url: str, token: str) -> Optional[Dict[str, Any]]:
    """GET /health → {loggedIn, sessionDead, ...} or None if unreachable.

    Distinguishes the two failure modes the user must act on differently:
      - None            → bridge process is DOWN (service stopped / never started)
      - {loggedIn:False}→ bridge is UP but the Zalo session is logged out/expired
    """
    try:
        import urllib.request
        import json as _json
        req = urllib.request.Request(f"{bridge_url}/health")
        if token:
            req.add_header("x-bridge-token", token)
        with urllib.request.urlopen(req, timeout=5) as r:
            return _json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def _bridge_cli_hint() -> str:
    """Best-effort name of the bridge CLI for copy-paste hints."""
    import shutil
    if shutil.which("hermes-zalo-plugin"):
        return "hermes-zalo-plugin"
    return "npx hermes-zalo-plugin"  # works without a global install


def _run_bridge_login() -> bool:
    """Run the bridge's QR login interactively (blocks until scanned/failed).

    Returns True on success. Uses the installed CLI if present, else npx.
    """
    import subprocess
    import shutil
    cli = "hermes-zalo-plugin" if shutil.which("hermes-zalo-plugin") else None
    cmd = [cli, "login"] if cli else ["npx", "hermes-zalo-plugin", "login"]
    try:
        # Inherit stdio so the ASCII QR renders and the user can scan it.
        return subprocess.run(cmd).returncode == 0
    except Exception as e:
        logger.warning("Zalo: could not launch bridge login: %s", e)
        return False


def _fetch_contacts(bridge_url: str, token: str) -> Optional[Dict[str, Any]]:
    """GET /contacts from the bridge → {groups:[{id,name}], friends:[{id,name}]}.
    Returns None if the bridge is unreachable or not logged in."""
    try:
        import urllib.request
        import json as _json
        req = urllib.request.Request(f"{bridge_url}/contacts")
        if token:
            req.add_header("x-bridge-token", token)
        with urllib.request.urlopen(req, timeout=15) as r:
            data = _json.loads(r.read().decode("utf-8"))
        if not data.get("success"):
            return None
        return {"groups": data.get("groups") or [], "friends": data.get("friends") or []}
    except Exception:
        return None


def _norm_text(s: str) -> str:
    """Lowercase + strip Vietnamese diacritics for forgiving name search."""
    import unicodedata
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.replace("đ", "d").replace("Đ", "D").lower().strip()


def _pick_ids(items: List[Dict[str, Any]], label: str, prompt_fn, print_fn) -> str:
    """Interactive picker over a possibly long {id,name} list.

    Commands at the prompt:
      <text>   search names (diacritic-insensitive); shows numbered matches
      <n,n,..> pick by number from the LAST shown list (accumulates)
      all      list everything (careful with long lists)
      done     show current picks
      <blank>  finish and return selected ids
    Raw ids can be pasted directly too.
    """
    print_fn(label)
    print_fn(f"   {len(items)} item(s). Type a name to search, numbers to pick, 'all' to list, blank to finish.")
    selected: Dict[str, str] = {}  # id -> name
    shown = items[: min(20, len(items))]  # default: first 20

    def _render(lst):
        if not lst:
            print_fn("   (no matches)")
            return
        for i, it in enumerate(lst, 1):
            mark = "✓" if str(it.get("id", "")) in selected else " "
            print_fn(f"   [{mark}] {i}. {it.get('name','?')}  ({it.get('id','')})")

    _render(shown)
    while True:
        raw = prompt_fn("search / numbers / 'all' / blank=done", default="")
        if raw is None:
            break
        raw = raw.strip()
        if not raw:
            break
        if raw.lower() == "all":
            shown = items
            _render(shown)
            continue
        if raw.lower() == "done":
            if selected:
                print_fn("   Selected: " + ", ".join(selected.values()))
            else:
                print_fn("   (nothing selected yet)")
            continue
        # If it looks like raw id(s) pasted directly (long digit strings) → add.
        toks = [t for t in raw.replace(" ", "").split(",") if t]
        if toks and all(t.isdigit() and len(t) >= 8 for t in toks):
            for t in toks:
                selected[t] = t
            print_fn("   Selected: " + ", ".join(selected.values()))
            continue
        # Pure short number / number-list → pick from current `shown`.
        if toks and all(t.isdigit() for t in toks):
            for t in toks:
                idx = int(t) - 1
                if 0 <= idx < len(shown):
                    it = shown[idx]
                    selected[str(it.get("id", ""))] = it.get("name", it.get("id", ""))
            print_fn("   Selected: " + (", ".join(selected.values()) or "(none)"))
            continue
        # Otherwise treat as a search query over names.
        q = _norm_text(raw)
        shown = [it for it in items if q in _norm_text(it.get("name", ""))]
        print_fn(f"   {len(shown)} match(es) for '{raw}':")
        _render(shown)
    return ",".join([i for i in selected.keys() if i])


def interactive_setup() -> None:
    """Interactive `hermes gateway setup` flow for Zalo."""
    from hermes_cli.setup import (
        prompt,
        prompt_yes_no,
        save_env_value,
        get_env_value,
        print_header,
        print_info,
        print_warning,
    )

    print_header("Zalo")
    print_info("Connect Hermes to a personal Zalo account via the zca-js bridge.")
    print_warning("zca-js is an UNOFFICIAL API. Use a secondary account; Zalo may lock automated accounts.")
    print_info("You must run the companion hermes-zalo-plugin Node service and log in via QR first.")
    print()

    existing = get_env_value("ZALO_PLUGIN_URL")
    bridge_url = prompt(
        "Bridge URL (e.g. http://127.0.0.1:8787)",
        default=existing or "http://127.0.0.1:8787",
    )
    if not bridge_url:
        print_warning("Bridge URL is required — skipping Zalo setup")
        return
    save_env_value("ZALO_PLUGIN_URL", bridge_url.strip().rstrip("/"))

    if prompt_yes_no("Set a bridge token (shared secret)?", False):
        token = prompt("Bridge token", password=True)
        if token:
            save_env_value("ZALO_PLUGIN_TOKEN", token)

    print()
    print_info("Access control: WHO may talk to the bot (Telegram-style)")
    print_info("Leave selections EMPTY to allow everyone / everywhere.")

    # Probe the bridge first so we can give a precise, actionable diagnosis
    # instead of a vague "offline/not logged in". Three states matter:
    #   1) DOWN          → service stopped: offer to start it (safe, no QR)
    #   2) LOGGED OUT    → session expired: offer to QR-login right now
    #   3) OK            → auto-list contacts for number-pick
    bridge = bridge_url.strip().rstrip("/")
    token = os.getenv("ZALO_PLUGIN_TOKEN", "")
    cli = _bridge_cli_hint()
    health = _probe_health(bridge, token)

    if health is None:
        # State 1: bridge process not reachable.
        print()
        print_warning(f"Bridge không phản hồi tại {bridge} (service đang tắt hoặc chưa khởi động).")
        print_info("Phiên đăng nhập (credentials) vẫn được giữ — chỉ cần bật lại service, KHÔNG cần quét QR lại.")
        if prompt_yes_no("Bật lại background service ngay bây giờ?", True):
            import subprocess, shutil
            svc_cli = "hermes-zalo-plugin" if shutil.which("hermes-zalo-plugin") else None
            svc_cmd = [svc_cli, "setup", "--service-only"] if svc_cli else ["npx", "hermes-zalo-plugin", "setup", "--service-only"]
            try:
                subprocess.run(svc_cmd)
            except Exception as e:
                print_warning(f"Không tự bật được service: {e}")
            # Re-probe after the attempt.
            import time as _t
            _t.sleep(2)
            health = _probe_health(bridge, token)
            if health is None:
                print_warning("Bridge vẫn chưa lên. Bật thủ công rồi chạy lại `hermes gateway setup`:")
                print_info(f"   {cli} setup --service-only        # nếu cài qua npm")
                print_info("   npm start                         # nếu chạy từ source")
        else:
            print_info("Bỏ qua. Khi nào muốn bật: " + f"{cli} setup --service-only  (hoặc `npm start`)")

    if health is not None and (not health.get("loggedIn") or health.get("sessionDead")):
        # State 2: bridge is up but the Zalo session is dead/logged out.
        print()
        print_warning("Bridge đang chạy nhưng phiên Zalo đã ĐĂNG XUẤT / hết hạn.")
        print_info("Cần đăng nhập lại bằng cách quét mã QR trong app Zalo (Zalo → + → Quét mã QR).")
        if prompt_yes_no("Quét QR đăng nhập lại ngay bây giờ?", True):
            if _run_bridge_login():
                print_info("✓ Đăng nhập lại thành công.")
                import time as _t
                _t.sleep(2)
                health = _probe_health(bridge, token)
            else:
                print_warning(f"Đăng nhập chưa xong. Chạy lại sau bằng:  {cli} login")
        else:
            print_info(f"Khi nào muốn đăng nhập lại:  {cli} login   (rồi chạy lại `hermes gateway setup`)")

    # Try to fetch a friendly id+name list from the bridge so the user can pick
    # by number instead of hunting for raw IDs. Falls back to manual entry.
    contacts = _fetch_contacts(bridge, token) if (health and health.get("loggedIn") and not health.get("sessionDead")) else None

    # A) Allowed senders (users).
    friends = (contacts or {}).get("friends") or []
    if friends:
        users_csv = _pick_ids(
            friends,
            "Restrict to specific USERS? Enter numbers (e.g. 1,3) or blank for everyone",
            prompt, print_info,
        )
    else:
        users_csv = prompt(
            "Allowed user IDs (comma-separated uidFrom, blank = everyone)",
            default=get_env_value("ZALO_ALLOWED_USERS") or "",
        )
    save_env_value("ZALO_ALLOWED_USERS", (users_csv or "").strip())

    # B) Allowed threads (groups + DMs).
    groups = (contacts or {}).get("groups") or []
    if groups:
        threads_csv = _pick_ids(
            groups,
            "Restrict to specific GROUPS/threads? Enter numbers or blank for everywhere",
            prompt, print_info,
        )
    else:
        threads_csv = prompt(
            "Allowed thread/group IDs (comma-separated, blank = everywhere)",
            default=get_env_value("ZALO_ALLOWED_THREADS") or "",
        )
    save_env_value("ZALO_ALLOWED_THREADS", (threads_csv or "").strip())

    # C) Group response mode. Only ask when the user picked specific groups.
    # If they left the group picker blank, that means "no groups" → set group
    # mode to "off" so the bot never replies in any group, even when @mentioned
    # (groups opt-in). DMs / 1-1 chats still work.
    if (threads_csv or "").strip():
        print_info("In GROUPS, when should the bot respond?")
        _gm_opts = [
            ("mention", "Chỉ khi được @nhắc tên hoặc trả lời tin của bot (khuyên dùng)"),
            ("all", "Mọi tin nhắn trong các nhóm được phép"),
            ("off", "Không bao giờ trong nhóm (chỉ chat riêng/DM)"),
        ]
        for i, (val, desc) in enumerate(_gm_opts, 1):
            print_info(f"   {i}. {val:<8} — {desc}")
        _cur_mode = get_env_value("ZALO_GROUP_MODE") or "mention"
        _cur_idx = next((str(i) for i, (v, _) in enumerate(_gm_opts, 1) if v == _cur_mode), "1")
        _pick = prompt("Chọn (1/2/3)", default=_cur_idx)
        try:
            mode = _gm_opts[int(str(_pick).strip()) - 1][0]
        except (ValueError, IndexError):
            # Fall back to accepting the literal word, else default.
            mode = (str(_pick) or "").strip().lower()
            if mode not in {"mention", "all", "off"}:
                mode = "mention"
        save_env_value("ZALO_GROUP_MODE", mode)
        print_info(f"   → {mode}")
    else:
        # No groups chosen → bot stays out of every group (DMs still work).
        save_env_value("ZALO_GROUP_MODE", "off")
        print_info("   → Không chọn nhóm nào → bot sẽ KHÔNG trả lời trong nhóm (kể cả khi @nhắc). Chat 1-1 (DM) vẫn hoạt động.")

    # Discoverability helper: log inbound ids so the user can add more later.
    if prompt_yes_no("Log sender/thread IDs of incoming messages (to find IDs later)?", False):
        save_env_value("ZALO_LOG_IDS", "true")
    else:
        save_env_value("ZALO_LOG_IDS", "false")

    retention = prompt(
        "Undo-cache retention in days — how long to keep the msgId→cliMsgId map "
        "on disk so message recall (thu hồi) works across bridge restarts "
        "(default 30, 0 to disable persistence)",
        default=get_env_value("ZALO_CLIMSG_RETENTION_DAYS") or "30",
    )
    if retention is not None and str(retention).strip() != "":
        try:
            save_env_value("ZALO_CLIMSG_RETENTION_DAYS", str(int(retention)))
        except ValueError:
            print_warning("Invalid number — keeping default 30 days")

    print()
    print_info("🔐 Access control — bot được phép làm những NHÓM hành động nào?")
    print_info("   Mức độ nguy hiểm tăng dần: read < send < interact < manage < destructive")
    _ag_opts = [
        ("read", "Xem — đọc tin, danh bạ, thông tin nhóm/bạn"),
        ("send", "Gửi — nhắn tin, ảnh, file, sticker, voice"),
        ("interact", "Tương tác — react, reply, vote/poll, gõ '...'"),
        ("manage", "Quản lý — thêm/xoá thành viên, đổi tên nhóm, kết bạn"),
        ("destructive", "NGUY HIỂM — giải tán nhóm, xoá tin, block, rời nhóm, đổi profile"),
    ]
    for i, (val, desc) in enumerate(_ag_opts, 1):
        print_info(f"   {i}. {val:<12} — {desc}")
    print_info("   6. custom       — Tự chọn TỪNG action cụ thể (chỉ những cái chọn mới chạy, còn lại CHẶN hết)")
    # Default to the currently-saved set, else the safe preset read,send,interact (1,2,3).
    _raw_groups = (get_env_value("ZALO_ALLOWED_ACTION_GROUPS") or "").strip()
    _raw_allowed = (get_env_value("ZALO_ALLOWED_ACTIONS") or "").strip()
    # Whitelist mode = an explicit allowlist exists AND no groups are enabled.
    _cur_custom = bool(_raw_allowed) and not _raw_groups
    _cur = _raw_groups or "read,send,interact"
    if _cur_custom:
        _cur_nums = "6"
    elif _cur.lower() == "all":
        _cur_nums = "1,2,3,4,5"
    else:
        _cur_set = {s.strip() for s in _cur.split(",") if s.strip()}
        _cur_nums = ",".join(str(i) for i, (v, _) in enumerate(_ag_opts, 1) if v in _cur_set) or "1,2,3"
    print_info("   Nhập số cách nhau bởi dấu phẩy (vd: 1,2,3), 'all' cho tất cả, hoặc 6 để tự chọn từng action.")
    _pick = prompt("Chọn nhóm hành động", default=_cur_nums)
    _pick = (str(_pick) or "").strip()

    _pick_nums = {t.strip() for t in _pick.split(",")}
    if "6" in _pick_nums or _pick.lower() == "custom":
        # ── Custom mode: whitelist-only. Pick specific actions; everything else
        #    is denied. We clear ZALO_ALLOWED_ACTION_GROUPS so no group passes by
        #    default, and put the picks in ZALO_ALLOWED_ACTIONS.
        print()
        print_info("Chế độ CUSTOM (whitelist) — chỉ những action được chọn mới chạy, tất cả còn lại bị chặn.")
        action_items = [
            {"id": name, "name": f"{name}  [{grp}]"}
            for name, grp in sorted(_ACTION_GROUP.items())
        ]
        # Seed the picker default selection from any currently-saved allowlist.
        _picked_csv = _pick_ids(
            action_items,
            f"Chọn action cho phép (trong {len(action_items)} API). "
            "Gõ tên để tìm (vd: send, group, poll), số để tick, 'all' để liệt kê, blank=xong",
            prompt, print_info,
        )
        allowed = [a.strip() for a in (_picked_csv or "").split(",") if a.strip()]
        save_env_value("ZALO_ALLOWED_ACTIONS", ",".join(allowed))
        save_env_value("ZALO_ALLOWED_ACTION_GROUPS", "")  # whitelist-only
        save_env_value("ZALO_DENIED_ACTIONS", "")          # not needed in whitelist mode
        # If any picked action is destructive, the bridge still needs the opt-in.
        has_destructive = any(_ACTION_GROUP.get(a) == "destructive" for a in allowed)
        if has_destructive:
            print_warning(
                "⚠️  Một số action đã chọn thuộc nhóm NGUY HIỂM (destructive). "
                "Bridge cần bật cờ riêng mới chạy được chúng."
            )
            allow_destructive = prompt_yes_no("Cho phép các action NGUY HIỂM đã chọn?", False)
            save_env_value("ZALO_ALLOW_DESTRUCTIVE", "true" if allow_destructive else "false")
        else:
            save_env_value("ZALO_ALLOW_DESTRUCTIVE", "false")
        print_info(f"   → custom allowlist ({len(allowed)} action): {', '.join(allowed) or '(trống — bot sẽ không làm gì)'}")
    else:
        if _pick.lower() == "all":
            groups_val = "all"
        else:
            chosen = []
            for tok in _pick.split(","):
                tok = tok.strip()
                if not tok or tok == "6":
                    continue
                try:
                    chosen.append(_ag_opts[int(tok) - 1][0])
                except (ValueError, IndexError):
                    if tok.lower() in {v for v, _ in _ag_opts}:
                        chosen.append(tok.lower())  # accept literal names too
            groups_val = ",".join(dict.fromkeys(chosen)) or "read,send,interact"
        save_env_value("ZALO_ALLOWED_ACTION_GROUPS", groups_val)
        save_env_value("ZALO_ALLOWED_ACTIONS", "")  # clear any leftover custom allowlist
        print_info(f"   → {groups_val}")

        # Destructive opt-in only matters when not in whitelist mode.
        _has_destructive_group = groups_val == "all" or "destructive" in groups_val
        if _has_destructive_group:
            print_warning(
                "⚠️  DESTRUCTIVE actions (giải tán nhóm, xoá tin, block, đổi profile) là "
                "KHÔNG THỂ HOÀN TÁC. Bất kỳ ai bot nghe đều có thể kích hoạt. Chỉ bật nếu "
                "bạn hoàn toàn tin tưởng mọi người được phép."
            )
            allow_destructive = prompt_yes_no("Cho phép các action NGUY HIỂM (destructive)?", False)
            save_env_value("ZALO_ALLOW_DESTRUCTIVE", "true" if allow_destructive else "false")
        else:
            save_env_value("ZALO_ALLOW_DESTRUCTIVE", "false")

    home = prompt(
        "Home thread for cron delivery (threadId or group:threadId, optional)",
        default=get_env_value("ZALO_HOME_CHANNEL") or "",
    )
    if home:
        save_env_value("ZALO_HOME_CHANNEL", home.strip())

    # ── Next steps: make sure the user always knows how to get a working bot ──
    print()
    print_info("─────────────────────────────────────────────")
    if health and health.get("loggedIn") and not health.get("sessionDead"):
        print_info("✓ Zalo đã sẵn sàng: bridge đang chạy và đã đăng nhập.")
        print_info("  Chạy:  hermes gateway   → bắt đầu nhận/gửi tin Zalo.")
    else:
        print_warning("⚠ Cấu hình Zalo đã lưu, NHƯNG bridge chưa sẵn sàng — bot sẽ chưa hoạt động.")
        print_info("  Bridge (Node service) phải ĐANG CHẠY và đã đăng nhập thì bot mới chạy được.")
        print_info(f"  • Kiểm tra:        {cli} status")
        print_info(f"  • Bật service:     {cli} setup --service-only   (đã login thì không cần QR)")
        print_info(f"  • Đăng nhập QR:    {cli} login                  (nếu bị đăng xuất)")
        print_info("  Xong rồi chạy:  hermes gateway")
    print_info("─────────────────────────────────────────────")


def is_connected() -> bool:
    """Lightweight check used by `hermes gateway status` (env-only)."""
    return bool(os.getenv("ZALO_PLUGIN_URL"))


def register(ctx):
    """Plugin entry point: called by the Hermes plugin system."""
    ctx.register_platform(
        name="zalo",
        label="Zalo",
        adapter_factory=lambda cfg: ZaloAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["ZALO_PLUGIN_URL"],
        install_hint="Run the hermes-zalo-plugin Node service and `pip install aiohttp`",
        setup_fn=interactive_setup,
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="ZALO_HOME_CHANNEL",
        allowed_users_env="ZALO_ALLOWED_USERS",
        allow_all_env="ZALO_ALLOW_ALL_USERS",
        max_message_length=4000,
        emoji="",
        pii_safe=False,
        allow_update_command=True,
        platform_hint=(
            "You are chatting via Zalo (a Vietnamese messaging app). Zalo does "
            "not render markdown — use plain text only. The user likely writes "
            "in Vietnamese; reply in Vietnamese unless they switch. Keep replies "
            "concise and conversational. You can send images, files, stickers, "
            "and voice. Messages over ~4000 chars are auto-split."
        ),
    )

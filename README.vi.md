<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-zalo-plugin/main/assets/logo.svg" alt="hermes-zalo-plugin" width="660">
</p>

# hermes-zalo-plugin

[English](./README.md) · 📖 **Tiếng Việt**

[![npm version](https://img.shields.io/npm/v/hermes-zalo-plugin.svg)](https://www.npmjs.com/package/hermes-zalo-plugin)
[![npm downloads](https://img.shields.io/npm/dm/hermes-zalo-plugin.svg)](https://www.npmjs.com/package/hermes-zalo-plugin)
[![GitHub stars](https://img.shields.io/github/stars/cuongdev/hermes-zalo-plugin?style=social)](https://github.com/cuongdev/hermes-zalo-plugin/stargazers)
[![license](https://img.shields.io/npm/l/hermes-zalo-plugin.svg)](./LICENSE)

Cầu nối (bridge) Node.js kết nối **zca-js** (API Zalo cá nhân KHÔNG chính thức)
với gateway của **Hermes Agent**. Nhờ nó, bạn có thể chat với Hermes agent từ
một tài khoản Zalo cá nhân.

```
Máy chủ Zalo  <──>  [ bridge này: Node + zca-js ]  <──>  [ adapter Hermes: platform "zalo" ]
```

- **Zalo ↔ bridge:** sự kiện chiều vào đến qua **ws** (listener); hành động chiều
  ra (gửi / upload / react…) đi qua **HTTPS** tới API của Zalo.
- **bridge ↔ Hermes — chiều vào** (Zalo → Hermes): Server-Sent Events tại
  `GET /events` (heartbeat mỗi 15s + replay `Last-Event-ID` từ ring buffer).
- **bridge ↔ Hermes — chiều ra** (Hermes → Zalo): REST `POST /send`,
  `/send-attachment`, `/send-sticker`, `/send-voice`, `/typing`.

**Vì sao chọn zca-js (thay vì thư viện Zalo không chính thức bằng Python)?** Cả
hai đều **KHÔNG chính thức**, dựng bằng reverse-engineer cho API tài khoản Zalo
**cá nhân** — không cái nào được Zalo bảo trợ. Mình chọn
[zca-js](https://www.npmjs.com/package/zca-js) vì nó **còn được bảo trì tích cực
hơn** và **hỗ trợ nhiều chức năng hơn** so với bản Python: bám theo thay đổi
protocol của Zalo, bao phủ nhắn tin, media, sticker, reaction, nhóm, poll, kết
bạn… đủ 145 method mà bridge này phơi ra. Cái giá của lựa chọn đó — zca-js là
TypeScript còn Hermes là Python — chính là thứ mà bridge Node mỏng này gánh.

> ⚠️ **zca-js là API KHÔNG CHÍNH THỨC.** Nên dùng tài khoản Zalo phụ. Zalo có
> thể giới hạn tốc độ (rate-limit) hoặc khóa tài khoản tự động hóa. Bạn tự chịu
> rủi ro này.

## Yêu cầu

Trước khi cài, cần có sẵn:

| Yêu cầu | Để làm gì | Lấy ở đâu |
|---------|-----------|-----------|
| **Node.js ≥ 18** (kèm `npm`) | chạy bridge | macOS: `brew install node` · Linux: [nvm](https://github.com/nvm-sh/nvm) hoặc gói `nodejs` của distro · Windows: bộ cài LTS tại [nodejs.org](https://nodejs.org). Kiểm tra: `node -v` |
| **Tài khoản Zalo** (nên dùng phụ) | bridge đăng nhập bằng tài khoản này | app Zalo trên điện thoại để quét QR |
| **Đã cài Hermes Agent** | agent chat nói chuyện với bridge | lệnh `hermes` có trên PATH |
| **Python `aiohttp`** | adapter Zalo phía Hermes dùng cho HTTP/SSE | `pip install aiohttp` (luồng `hermes gateway setup` Zalo cũng nhắc lại) |

Trình cài đặt kiểm tra Node + npm và dừng lại với thông báo rõ ràng nếu thiếu —
không chạy nửa chừng rồi để bạn bối rối. Bản thân zca-js **không cần công cụ
build** (không `bun`, không trình biên dịch); nó được lấy bản dựng sẵn từ npm.

## Bắt đầu nhanh (chỉ 1 lần)

<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-zalo-plugin/main/assets/setup-flow.svg" alt="4 bước: cài, quét QR, đăng ký Hermes, chat từ Zalo" width="620">
</p>

Chạy trên **macOS, Linux, và Windows** — Node lo hết; không cần `bun`, không cần
build từ source (zca-js lấy từ npm).

**Điều kiện:** Node.js ≥ 18 ([nodejs.org](https://nodejs.org)).

**Cài từ npm (khuyến nghị):**

```bash
npm install -g hermes-zalo-plugin
hermes-zalo-plugin setup      # đăng nhập QR + dịch vụ nền
```

**Hoặc từ source checkout:**

```bash
# macOS / Linux
./install.sh

# Windows (PowerShell)
.\install.ps1
```

Trình cài đặt sẽ:
1. cài dependencies (khi chạy từ source),
2. hướng dẫn **đăng nhập QR** (quét một lần; credentials được lưu vào
   `~/.hermes-zalo/`), và
3. cài **dịch vụ nền** tự khởi động bridge khi đăng nhập/khởi động máy và tự
   chạy lại khi crash — launchd (macOS), systemd user unit (Linux), hoặc
   Scheduled Task (Windows).

Các lệnh CLI: `hermes-zalo-plugin setup | login | start | stop | status | uninstall`.

Sau đó đăng ký vào Hermes:

```bash
hermes gateway setup     # chọn "Zalo" (🇻🇳)
hermes gateway           # bắt đầu chuyển tiếp tin
```

Vậy là xong — đăng nhập + setup chỉ làm một lần; bridge tự sống.

### Cờ tùy chọn của installer

| Cờ | Tác dụng |
|----|----------|
| `--no-service` | Chỉ cài deps + login; tự chạy bridge bằng `npm start`. |
| `--relogin` | Bắt buộc đăng nhập QR lại (vd khi phiên hết hạn). |
| `--service-only` | Chỉ (cài lại) dịch vụ nền. |

Gỡ dịch vụ nền (giữ lại credentials):

```bash
node uninstall.mjs            # dừng + gỡ dịch vụ tự khởi động
node uninstall.mjs --purge    # xóa luôn credentials đã lưu (đăng xuất)
```

## Cài thủ công (nâng cao)

Nếu bạn không muốn dùng trình cài đặt:

```bash
npm install                  # lấy zca-js từ npm
node login.mjs               # đăng nhập QR (--force để quét lại)
npm start                    # chạy bridge ở foreground
```

Bạn cũng có thể lấy QR trong lúc server đang chạy:
`GET /qr` (JSON kèm ảnh base64) hoặc `GET /qr.png` (ảnh PNG thô).

## 3. Cấu hình (biến môi trường)

| Biến | Mặc định | Ý nghĩa |
|------|----------|---------|
| `ZALO_PLUGIN_PORT` | `8787` | Cổng lắng nghe |
| `ZALO_PLUGIN_HOST` | `127.0.0.1` | Host bind (giữ loopback trừ khi bạn thêm TLS) |
| `ZALO_PLUGIN_TOKEN` | _(trống)_ | Khóa bí mật dùng chung; nếu đặt, mọi route đều yêu cầu (header `x-bridge-token`, `Authorization: Bearer`, hoặc `?token=`) |
| `ZALO_DATA_DIR` | `~/.hermes-zalo` | Thư mục gốc cho mọi dữ liệu runtime (credentials, QR, cache thu hồi, log). Đặt `./data` để dùng kiểu cũ trong repo. Các biến từng-file bên dưới override từng đường dẫn. |
| `ZALO_CREDENTIALS_PATH` | `~/.hermes-zalo/credentials.json` | Nơi lưu credentials |
| `ZALO_QR_PATH` | `~/.hermes-zalo/qr.png` | Nơi ghi ảnh QR |
| `ZALO_SELF_LISTEN` | tắt | Nhận cả tin nhắn do chính mình gửi đi |
| `ZALO_FORCE_QR` | tắt | Bỏ qua credentials đã lưu, đăng nhập lại bằng QR |
| `ZALO_CLIMSG_RETENTION_DAYS` | `30` | Số ngày giữ cache thu hồi (msgId→cliMsgId) trên đĩa tại `~/.hermes-zalo/climsgids/` (JSONL xoay theo ngày, tự dọn). Nạp lại khi khởi động để chức năng thu hồi (undo) sống sót qua restart. `0` = tắt lưu đĩa (chỉ trong RAM). |
| `ZALO_ALLOWED_ACTION_GROUPS` | `read,send,interact` | Danh sách nhóm quyền (phân theo mức độ nguy hiểm): `read` < `send` < `interact` < `manage` < `destructive` (hoặc `all`). Chặn CẢ `/api/<method>` lẫn các route first-class. |
| `ZALO_ALLOW_DESTRUCTIVE` | `false` | Phải `true` mới cho phép nhóm `destructive` (disperseGroup, deleteMessage, deleteChat, removeFriend, blockUser, leaveGroup, changeGroupOwner, updateProfile/Settings…). TẮT ngay cả khi groups=`all`. |
| `ZALO_ALLOWED_ACTIONS` | _(trống)_ | Allowlist tùy chỉnh — danh sách tên method zca-js luôn được phép, bất kể nhóm. |
| `ZALO_DENIED_ACTIONS` | _(trống)_ | Denylist tùy chỉnh — danh sách method luôn bị chặn. Ưu tiên cao nhất (thắng cả allowlist, groups, mọi thứ). |

### Phân quyền hành động (action permissions)

Bridge phân loại toàn bộ 145 hành động của zca-js thành 5 nhóm theo mức độ nguy
hiểm và từ chối (HTTP `403`) bất kỳ hành động nào không được chính sách cho
phép. Thứ tự ưu tiên:

1. `ZALO_DENIED_ACTIONS` — luôn chặn.
2. `ZALO_ALLOWED_ACTIONS` — luôn cho phép.
3. Nhóm `destructive` — chỉ khi `ZALO_ALLOW_DESTRUCTIVE=true`.
4. `ZALO_ALLOWED_ACTION_GROUPS` — nhóm của method phải nằm trong danh sách.

Số lượng mỗi nhóm: read 55, send 12, interact 13, manage 39, destructive 26.
Bảng phân loại đầy đủ nằm trong `permissions.js` (tự sinh). `GET /policy` trả về
chính sách đang áp dụng + danh sách hành động được phép đã giải quyết.

### Ai được nhắn với bot (người gửi / thread / chế độ nhóm)

Đây là các biến **phía adapter** (đặt nơi chạy `hermes gateway`), kiểu giống
Telegram — để TRỐNG = cho phép tất cả / mọi nơi:

| Biến | Mặc định | Tác dụng |
|------|----------|----------|
| `ZALO_ALLOWED_USERS` | _(trống=tất cả)_ | Danh sách uid người gửi được phép điều khiển bot. |
| `ZALO_ALLOWED_THREADS` | _(trống=tất cả)_ | Danh sách id thread/nhóm mà bot hoạt động trong đó. |
| `ZALO_GROUP_MODE` | `mention` | Trong nhóm: `mention` (chỉ khi được @nhắc hoặc trả lời vào tin bot — phát hiện bằng uid thật, không đoán theo chữ), `all` (mọi tin nhắn), hoặc `off` (chỉ chat 1-1). |
| `ZALO_LOG_IDS` | `false` | Log `uid`/`threadId` của mỗi tin đến để bạn tìm id thêm vào allowlist. |

Trình wizard (`hermes gateway setup` → Zalo) gọi `/contacts` và cho bạn **tìm
theo tên rồi chọn** thay vì phải gõ id thô.

> **Lưu ý mặc định** (chú ý sự bất đối xứng):
> - **Người dùng** — để trống `ZALO_ALLOWED_USERS` thì **bất kỳ ai** cũng nhắn
>   được với bot (cho phép tất cả, kiểu Telegram).
> - **Nhóm** — trong `hermes gateway setup`, nếu **không chọn nhóm nào**, wizard
>   set `ZALO_GROUP_MODE=off`: bot **không** trả lời trong **bất kỳ nhóm nào**
>   (kể cả khi được @nhắc). Chat 1-1 (DM) vẫn hoạt động. Chọn nhóm cụ thể để rồi
>   chọn cách bot xử trong nhóm (`mention` / `all` / `off`).

### Giới hạn tốc độ gọi info (chống khóa tài khoản)

zca-js không chính thức; gọi dồn dập `getUserInfo`/`getGroupInfo`/`getAllGroups`/`getAllFriends`
có nguy cơ bị chặn tạm thời. Bridge cache các kết quả này theo id với TTL, xếp
hàng tuần tự với khoảng cách tối thiểu, và lùi dần (backoff, trả cache cũ) khi
nghi bị rate-limit:

| Biến | Mặc định | Tác dụng |
|------|----------|----------|
| `ZALO_INFO_CACHE_TTL` | `600` (giây) | TTL cache cho kết quả đọc info. |
| `ZALO_INFO_MIN_INTERVAL_MS` | `1500` | Số ms tối thiểu giữa 2 lần gọi info; backoff lũy thừa (tối đa 5 phút) khi gặp lỗi rate-limit. |

## 4. HTTP API

- `GET  /health` → `{ ok, loggedIn, sessionDead, sessionDeadReason, ownId, qr, sseClients }`
- `GET  /qr` / `GET /qr.png` → trạng thái QR / ảnh PNG
- `GET  /events` → luồng SSE (`event: message` / `status` / `session_dead` / `reaction` / `undo` / `friend_event` / `group_event`)
- `POST /relogin` → `{ forceQR? }` khôi phục phiên chết/hết hạn (chạy lại đăng nhập QR; rồi poll `/qr.png` để quét)
- `POST /shutdown` → dừng êm (đóng listener, SSE, file stream, thoát). SIGTERM/SIGINT cũng vậy.
- `POST /send` → `{ threadId, threadType: "user"|"group", text, mentions?, quote? }` (mentions = `[{pos,uid,len}]` để @nhắc; quote = một SendMessageQuote từ tin đến để trả lời)
- `POST /react` → `{ threadId, threadType, msgId, cliMsgId?, icon }` (icon = HEART/LIKE/HAHA/WOW/CRY/ANGRY/… hoặc raw)
- `POST /undo` → `{ threadId, threadType, msgId }` (thu hồi tin của mình; bridge tự tra cliMsgId thật từ cache echo của listener — chỉ cần truyền msgId)
- `POST /send-card` → `{ threadId, threadType, userId, phoneNumber? }` (gửi danh thiếp)
- `POST /friend/request|accept|reject` → `{ userId, msg? }`
- `GET  /friends` → liệt kê tất cả bạn bè · `GET /find-user?phone=` → tra theo số điện thoại
- `GET  /groups` → liệt kê tất cả nhóm (raw `gridVerMap`)
- `GET  /contacts` → `{ groups:[{id,name}], friends:[{id,name}] }` — danh sách id+tên thân thiện cho wizard (batched + cache + giới hạn tốc độ)
- `POST /group/create` `{name, members[]}` · `/group/add` `/group/remove` `/group/rename` `/group/deputy` `{groupId, members[]|name}` · `/group/leave` `{groupId, silent?}`
- `POST /poll/create` → `{ groupId, question, options[], expiredTime?, allowMultiChoices?, allowAddNewOption?, hideVotePreview?, isAnonymous? }`
- `POST /api/<method>` → `{ args: [...] }` — **passthrough chung tới BẤT KỲ method nào của zca-js** (đủ 145 API). Truyền args theo thứ tự như zca-js mô tả; dùng `"user"`/`"group"` ở vị trí cần ThreadType (tự chuyển đổi). Ví dụ: `/api/forwardMessage`, `/api/deleteMessage`, `/api/sendVideo`, `/api/getGroupMembersInfo`, `/api/getGroupChatHistory`, `/api/createReminder`, `/api/setMute`, `/api/votePoll`, `/api/blockUser`, `/api/updateProfile`. Method không tồn tại → lỗi.
- `POST /send-attachment` → `{ threadId, threadType, path | paths[], caption? }` (đường dẫn file local; ảnh/file/video tự định tuyến theo phần mở rộng)
- `POST /send-sticker` → `{ threadId, threadType, sticker: { id, cateId, type } }`
- `GET  /stickers?keyword=hi&limit=5` → tìm sticker, trả về object đầy đủ `{ id, cateId, type, ... }` sẵn sàng đưa vào `/send-sticker`
- `POST /send-voice` → `{ threadId, threadType, voiceUrl }`
- `POST /typing` → `{ threadId, threadType }`
- `GET  /chat-info?threadId=..&threadType=user|group`

Cấu trúc sự kiện `message` chiều vào:

```json
{
  "messageId": "...", "cliMsgId": "...",
  "threadId": "...", "threadType": "user|group",
  "senderId": "...", "senderName": "...", "text": "...",
  "attachment": null,
  "media": null,                 // {kind,url,fileName,ext,mime,size} cho image/voice/file/video
  "msgType": "webchat",
  "mentions": [],                // chỉ nhóm: danh sách uid được @nhắc trong tin này
  "quotedOwnerId": "",           // uid chủ nhân tin được trích dẫn (có khi là tin trả lời)
  "quote": { "...": "..." },     // payload quote thô để dựng tin trả lời
  "ts": "...", "isSelf": false
}
```

`mentions` và `quotedOwnerId` chính là cái adapter dùng để phát hiện "bot bị
nhắc đến" trong nhóm (khớp uid thật, không đoán theo chữ).

## 5. Kết nối plugin Hermes

`hermes-zalo-plugin setup` (và `install.sh` / `install.ps1` từ source) đã **đóng
gói sẵn và tự cài** adapter phía Hermes — copy `hermes-plugin/` vào
`~/.hermes/plugins/zalo/` và bật `zalo-platform` trong `~/.hermes/config.yaml`,
nên bình thường bạn không cần tự đặt file nào. Việc còn lại là khai báo *ai và
việc gì* bot được phép làm:

### Cách A — wizard hướng dẫn (khuyến nghị)

```bash
hermes gateway setup        # chọn "Zalo"
```

Wizard hỏi bridge URL/token, rồi — với bridge đã đăng nhập sẵn — lấy danh sách
nhóm và bạn bè (`GET /contacts`) và cho bạn **tìm theo tên rồi chọn** xem bot
được nhắn với ai / thread nào, chế độ trả lời trong nhóm, phân quyền hành động,
và thời gian giữ cache. Tất cả ghi vào `~/.hermes/.env`.

### Cách B — đặt env thủ công

```bash
export ZALO_PLUGIN_URL="http://127.0.0.1:8787"
# Phân quyền (kiểu Telegram: để trống = cho phép tất cả / mọi nơi)
# export ZALO_ALLOWED_USERS="<uid1>,<uid2>"      # giới hạn người gửi
# export ZALO_ALLOWED_THREADS="<groupId>,<uid>"  # giới hạn nhóm/chat 1-1
# export ZALO_GROUP_MODE="mention"               # mention | all | off
pip install aiohttp                               # nếu chưa có
hermes gateway   # adapter Zalo kết nối tới bridge và bắt đầu chuyển tiếp tin
```

Chạy bridge trước (đã đăng nhập), rồi mới chạy Hermes gateway.

> ⚠️ `ZALO_ALLOW_ALL_USERS` và `ZALO_GROUP_REQUIRE_MENTION` đã LỖI THỜI
> (deprecated). Để `ZALO_ALLOWED_USERS` trống là cho phép tất cả; dùng
> `ZALO_GROUP_MODE` thay cho cờ mention cũ.

## 6. Dùng hằng ngày

<p align="center">
  <img src="https://raw.githubusercontent.com/cuongdev/hermes-zalo-plugin/main/assets/zalo-chat.svg" alt="Tương tác với Hermes agent từ Zalo" width="300">
</p>

- **Chat 1-1:** nhắn tới tài khoản Zalo từ một điện thoại khác → agent trả lời
  (tùy theo `ZALO_ALLOWED_USERS`).
- **Trong nhóm:** mặc định (`ZALO_GROUP_MODE=mention`) bot chỉ trả lời khi được
  @nhắc hoặc khi có người trả lời vào một tin của bot. Đặt `all` để trả lời mọi
  tin, hoặc `off` để bỏ qua nhóm.
- **Tìm ID sau này:** đặt `ZALO_LOG_IDS=true`, gửi một tin, rồi đọc dòng
  `uid=… threadId=…` trong log gateway; thêm vào allowlist.
- **Đổi ai/việc gì được phép:** sửa các biến `ZALO_*` trong `~/.hermes/.env`
  (phía adapter: users/threads/mode) hoặc env của bridge (phân quyền hành động,
  rate-limit), rồi khởi động lại gateway / bridge.
- **Gửi media / sticker / reaction / poll:** agent gọi các route của bridge ở
  trên; toàn bộ 145 API đều với tới được qua `POST /api/<method>` tùy theo chính
  sách phân quyền.

## 7. Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách khắc phục |
|-------------|------------------------------|
| `/health` báo `loggedIn:false` | Chưa thiết lập phiên — chạy `ZALO_FORCE_QR=1 node server.js` rồi quét, hoặc `POST /relogin`. |
| `/health` báo `sessionDead:true` | Đã đăng nhập nơi khác / bị kick / cookie hết hạn. `POST /relogin {forceQR:true}` rồi quét lại. |
| Hành động trả HTTP 403 | Bị chính sách phân quyền chặn — xem `GET /policy`; nới `ZALO_ALLOWED_ACTION_GROUPS` hoặc đặt `ZALO_ALLOW_DESTRUCTIVE=true` / `ZALO_ALLOWED_ACTIONS`. |
| Bot bỏ qua tin trong nhóm | `ZALO_GROUP_MODE=mention` mà bạn không @nhắc/trả lời; hoặc thread không nằm trong `ZALO_ALLOWED_THREADS`. |
| "Zalo info calls are backing off" | Đã chạm rate-limit; bridge đang tự giảm tốc. Chờ, hoặc tăng `ZALO_INFO_CACHE_TTL` để dựa vào cache. |
| `getGroupInfo` trả về rỗng | Phải gọi với MỘT MẢNG id; truyền 1 string đơn sẽ không trả gì. |
| Không thấy log realtime | Node buffer stdout khi không phải TTY — chạy với `stdbuf -oL -eL node server.js \| tee ~/.hermes-zalo/bridge.log`. |
| `hermes-zalo-plugin: command not found` sau khi `npm i -g` | Thư mục bin global của npm không nằm trên PATH (hay gặp khi cài bằng Node mà Hermes bundle ở `~/.hermes/node`). Từ v1.0.1, lệnh được tự symlink cạnh `node` của bạn khi cài; nếu vẫn không thấy, chạy `rehash` (zsh) / `hash -r` (bash) hoặc mở terminal mới — hoặc dùng `npx hermes-zalo-plugin <cmd>`. |

## Chạy như dịch vụ nền

Trình cài đặt đã thiết lập sẵn (launchd / systemd / Scheduled Task) nên bridge
tự khởi động và tự chạy lại khi crash. Nếu bạn dùng `--no-service`, chạy
`node install.mjs --service-only` để thêm sau, hoặc chỉ cần `npm start` để chạy
ở foreground. Bridge tự kết nối lại websocket Zalo (zca-js `retryOnClose`);
adapter Hermes tự kết nối lại luồng SSE với backoff + replay `Last-Event-ID`.

## Giấy phép

MIT © [Cường Tuấn Nguyễn](https://github.com/cuongdev)

## Lịch sử Star

Nếu dự án giúp ích cho bạn, một ⭐ sẽ giúp người khác tìm thấy nó.

[![Star History Chart](https://api.star-history.com/svg?repos=cuongdev/hermes-zalo-plugin&type=Date)](https://star-history.com/#cuongdev/hermes-zalo-plugin&Date)

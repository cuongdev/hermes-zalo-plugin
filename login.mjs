// login.mjs — standalone QR login for the Zalo bridge.
// Cross-platform (macOS / Linux / Windows). Run once (or with --force to
// re-login). Prints the QR in the terminal AND saves a PNG, then persists
// credentials to the data dir (~/.hermes-zalo by default) so the bridge
// starts without QR.
//
//   node login.mjs            # login if not already logged in
//   node login.mjs --force    # ignore saved credentials, re-scan QR

import fs from "node:fs";
import { ZaloClient } from "./zaloClient.js";
import { credentialsPath, qrPath } from "./paths.js";

const force = process.argv.includes("--force") || process.argv.includes("--relogin");

const CREDENTIALS_PATH = credentialsPath();
const QR_PATH = qrPath();

// Optional: pretty ASCII QR in the terminal if qrcode-terminal is available
// and zca-js gave us the QR payload. Falls back to the PNG path otherwise.
let qrterm = null;
try {
  qrterm = (await import("qrcode-terminal")).default;
} catch {
  /* optional dependency; PNG fallback still works */
}

function printQR(ev) {
  const data = ev?.data || {};
  // zca-js QRCodeGenerated payload carries a base64 PNG in `image`, and on some
  // versions the raw QR string in `code`. Prefer ASCII when we have the string.
  if (qrterm && typeof data.code === "string" && data.code) {
    console.log("\nScan this QR with the Zalo app (Zalo → + → Quét mã QR):\n");
    qrterm.generate(data.code, { small: true });
  } else {
    console.log(`\nQR code saved to:\n  ${QR_PATH}\nOpen it and scan with the Zalo app (Zalo → + → Quét mã QR).`);
  }
}

// Check whether a bridge is already running and logged in. If so we must NOT
// open a second Zalo connection (Zalo kicks the old one — DuplicateConnection
// 3000), so we skip login entirely.
async function bridgeAlreadyLoggedIn() {
  const port = process.env.ZALO_BRIDGE_PORT || "8787";
  const host = process.env.ZALO_BRIDGE_HOST || "127.0.0.1";
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const j = await res.json();
    return !!j.loggedIn && !j.sessionDead;
  } catch {
    return false; // no bridge running
  }
}

async function main() {
  // 0) If a bridge is already up and logged in, do nothing — opening a second
  //    session would get this account kicked.
  if (!force && (await bridgeAlreadyLoggedIn())) {
    console.log("✓ A bridge is already running and logged in — nothing to do.");
    console.log("  (Use --force only if you really want to re-scan; stop the bridge first to avoid a duplicate-session kick.)");
    process.exit(0);
  }
  if (force && (await bridgeAlreadyLoggedIn())) {
    console.error("✗ A bridge is currently running and logged in.");
    console.error("  Stop it first (e.g. `node uninstall.mjs` or stop the service), then re-run with --force.");
    console.error("  Re-logging in while it runs would kick the live session (DuplicateConnection).");
    process.exit(1);
  }

  if (!force && fs.existsSync(CREDENTIALS_PATH)) {
    // No live bridge, but we have saved credentials — verify they still work.
    const probe = new ZaloClient({ credentialsPath: CREDENTIALS_PATH, qrPath: QR_PATH });
    try {
      await probe.login({ forceQR: false });
      console.log(`✓ Already logged in (ownId=${probe.ownId}). Use --force to re-scan.`);
      try { await probe.shutdown?.(); } catch {}
      process.exit(0);
    } catch {
      console.log("Saved credentials no longer work — starting a fresh QR login…");
    }
  }

  const client = new ZaloClient({ credentialsPath: CREDENTIALS_PATH, qrPath: QR_PATH });

  // Surface QR events to the terminal (zaloClient may re-emit; harmless if not).
  client.on?.("qr", printQR);

  console.log("Starting Zalo QR login…");
  try {
    const res = await client.login({ forceQR: true });
    // login() resolves once the phone confirms; credentials are already saved.
    console.log(`\n✓ Logged in via ${res.method}. ownId=${client.ownId}`);
    console.log(`✓ Credentials saved to ${CREDENTIALS_PATH}`);
    console.log("\nNext step: run  hermes gateway setup  → choose Zalo.");
    try { await client.shutdown?.(); } catch {}
    process.exit(0);
  } catch (e) {
    console.error("\n✗ Login failed:", e?.message || e);
    process.exit(1);
  }
}

// zaloClient's loginQR callback logs QR status to stdout already; also poll
// qrState so we can render the ASCII QR as soon as it's generated.
main();

#!/usr/bin/env node
// bin/cli.mjs — CLI entry point for the hermes-zalo-bridge npm package.
//
//   hermes-zalo-bridge setup       # deps already installed by npm; login + service
//   hermes-zalo-bridge login       # QR login (--force to re-scan)
//   hermes-zalo-bridge start       # run the bridge in the foreground
//   hermes-zalo-bridge stop        # stop the background service
//   hermes-zalo-bridge status      # show bridge health + where data lives
//   hermes-zalo-bridge uninstall   # remove background service (--purge to wipe creds)
//
// Data (credentials, QR, undo-cache) lives in ~/.hermes-zalo/ by default
// (override with ZALO_DATA_DIR), so a global install survives package updates.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath;
const [, , cmd, ...rest] = process.argv;

function runNode(script, args = []) {
  const r = spawnSync(NODE, [path.join(ROOT, script), ...args], {
    stdio: "inherit",
    cwd: ROOT,
  });
  process.exit(r.status ?? 0);
}

async function status() {
  const port = process.env.ZALO_BRIDGE_PORT || "8787";
  const host = process.env.ZALO_BRIDGE_HOST || "127.0.0.1";
  console.log(`Data directory: ${dataDir()}`);
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) });
    const j = await res.json();
    console.log(`Bridge: RUNNING on http://${host}:${port}`);
    console.log(`  loggedIn=${j.loggedIn} sessionDead=${j.sessionDead} ownId=${j.ownId || "-"}`);
    if (j.sessionDead) console.log(`  ⚠ session dead: ${j.sessionDeadReason || "unknown"} — run 'hermes-zalo-bridge login --force' after stopping it.`);
  } catch {
    console.log(`Bridge: NOT running (no response on http://${host}:${port}).`);
    console.log("  Start it with: hermes-zalo-bridge start   (or 'setup' for background service)");
  }
}

function banner() {
  const tty = process.stdout.isTTY;
  const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const blue = (s) => c("38;5;33", s);
  const cyan = (s) => c("36", s);
  const dim = (s) => c("2", s);
  console.log(
    "\n" +
    blue("  ╦ ╦┌─┐┬─┐┌┬┐┌─┐┌─┐  ") + cyan("╔═╗┌─┐┬  ┌─┐") + "\n" +
    blue("  ╠═╣├┤ ├┬┘│││├┤ └─┐  ") + cyan("╔═╝├─┤│  │ │") + "\n" +
    blue("  ╩ ╩└─┘┴└─┴ ┴└─┘└─┘  ") + cyan("╚═╝┴ ┴┴─┘└─┘") + "\n" +
    dim("        H e r m e s   ×   Z a l o   b r i d g e  🇻🇳") + "\n",
  );
}

function help() {
  banner();
  console.log(`Usage: hermes-zalo-bridge <command> [options]

Commands:
  setup        Log in (QR) if needed and install a background auto-start service
  login        QR login only (--force to re-scan an existing session)
  start        Run the bridge in the foreground (Ctrl-C to stop)
  stop         Stop & remove the background service (alias of uninstall)
  status       Show bridge health and the data directory
  uninstall    Remove the background service (--purge also deletes credentials)
  help         Show this message

Data lives in ~/.hermes-zalo/ (override with ZALO_DATA_DIR).
After 'setup', register it in Hermes:  hermes gateway setup  → choose Zalo.`);
}

switch (cmd) {
  case "setup":
    runNode("install.mjs", rest);
    break;
  case "login":
    runNode("login.mjs", rest);
    break;
  case "start":
    runNode("server.js", rest);
    break;
  case "stop":
    runNode("uninstall.mjs", rest);
    break;
  case "uninstall":
    runNode("uninstall.mjs", rest);
    break;
  case "status":
    await status();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    help();
    break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    help();
    process.exit(1);
}

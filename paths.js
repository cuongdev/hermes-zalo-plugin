// paths.js — central resolution of where the bridge stores its data.
//
// When installed globally (npm i -g), the package directory is read-only and
// gets wiped on update, so credentials/QR/cache MUST live in the user's home,
// not next to the code. Resolution order:
//   1) explicit env (ZALO_DATA_DIR, or per-file ZALO_CREDENTIALS_PATH/ZALO_QR_PATH)
//   2) ~/.hermes-zalo/   (default for global/CLI installs)
//
// A local dev checkout can opt back into ./data by setting
// ZALO_DATA_DIR=./data (or running with that env), keeping old behaviour.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function dataDir() {
  const fromEnv = process.env.ZALO_DATA_DIR;
  const dir = fromEnv && fromEnv.trim()
    ? path.resolve(fromEnv.trim())
    : path.join(os.homedir(), ".hermes-zalo");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function credentialsPath() {
  return process.env.ZALO_CREDENTIALS_PATH || path.join(dataDir(), "credentials.json");
}

export function qrPath() {
  return process.env.ZALO_QR_PATH || path.join(dataDir(), "qr.png");
}

export function cliMsgDir() {
  return process.env.ZALO_CLIMSG_DIR || path.join(dataDir(), "climsgids");
}

export function logDir() {
  return process.env.ZALO_LOG_DIR || dataDir();
}

// uninstall.mjs — remove the background service for the Hermes Zalo bridge.
// Cross-platform. Optionally wipe saved credentials.
//
//   node uninstall.mjs              # stop + remove the auto-start service
//   node uninstall.mjs --purge      # also delete data/credentials.json (logout)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialsPath } from "./paths.js";

const PURGE = process.argv.includes("--purge");
const PLATFORM = process.platform;
const LABEL = "com.hermes.zalobridge";

function log(m) { console.log(m); }

function removeServiceDarwin() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  if (fs.existsSync(plistPath)) {
    spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
    fs.rmSync(plistPath, { force: true });
    log(`✓ Removed launchd service: ${plistPath}`);
  } else {
    log("• No launchd service found.");
  }
}

function removeServiceLinux() {
  const unitPath = path.join(os.homedir(), ".config", "systemd", "user", `${LABEL}.service`);
  if (spawnSync("systemctl", ["--version"], { stdio: "ignore" }).status === 0) {
    spawnSync("systemctl", ["--user", "disable", "--now", `${LABEL}.service`], { stdio: "ignore" });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  }
  if (fs.existsSync(unitPath)) {
    fs.rmSync(unitPath, { force: true });
    log(`✓ Removed systemd unit: ${unitPath}`);
  } else {
    log("• No systemd unit found.");
  }
}

function removeServiceWindows() {
  const taskName = "HermesZaloBridge";
  const r = spawnSync("schtasks", ["/Delete", "/F", "/TN", taskName], { stdio: "inherit", shell: true });
  if (r.status === 0) log(`✓ Removed Scheduled Task '${taskName}'.`);
  else log(`• No Scheduled Task '${taskName}' (or removal failed).`);
}

function removeService() {
  if (PLATFORM === "darwin") return removeServiceDarwin();
  if (PLATFORM === "linux") return removeServiceLinux();
  if (PLATFORM === "win32") return removeServiceWindows();
  log(`⚠ Unsupported platform '${PLATFORM}'. Nothing to remove.`);
}

function purgeCredentials() {
  const credPath = credentialsPath();
  if (fs.existsSync(credPath)) {
    fs.rmSync(credPath, { force: true });
    log(`✓ Deleted credentials: ${credPath} (you'll need to QR-login again).`);
  } else {
    log("• No saved credentials to delete.");
  }
}

console.log("Hermes Zalo Bridge — uninstaller\n================================");
removeService();
if (PURGE) purgeCredentials();
console.log("\nDone. (The bridge files themselves were left in place.)");

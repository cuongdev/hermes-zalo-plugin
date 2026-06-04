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

// Mirror of install.mjs installHermesPlugin(): remove the Python adapter from
// ~/.hermes/plugins/zalo and drop "zalo-platform" from plugins.enabled. Leaves
// the rest of config.yaml untouched.
function removeHermesPlugin() {
  const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  const dest = path.join(hermesHome, "plugins", "zalo");
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    log(`✓ Removed Hermes plugin: ${dest}`);
  } else {
    log("• No Hermes plugin directory to remove.");
  }

  const cfgPath = path.join(hermesHome, "config.yaml");
  try {
    if (disableZaloInConfig(cfgPath)) {
      log('✓ Removed "zalo-platform" from plugins.enabled in config.yaml');
    } else {
      log("• Plugin was not enabled in config.yaml (nothing to remove).");
    }
  } catch (e) {
    log(`⚠ Could not edit config.yaml: ${e.message}`);
    log('  Manually remove "zalo-platform" from plugins.enabled in ~/.hermes/config.yaml');
  }
}

// Dependency-free, idempotent: strip "zalo-platform" from plugins.enabled,
// whether it's an inline list ([a, zalo-platform]) or a block list. Returns
// true if something was removed, false if it wasn't there.
function disableZaloInConfig(cfgPath) {
  if (!fs.existsSync(cfgPath)) return false;
  const lines = fs.readFileSync(cfgPath, "utf-8").split("\n");

  const pluginsIdx = lines.findIndex((l) => /^plugins:\s*$/.test(l));
  if (pluginsIdx === -1) return false;

  // Find "enabled:" within the plugins block.
  let enabledIdx = -1;
  for (let i = pluginsIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== "") break; // left the block
    if (/^\s+enabled:/.test(lines[i])) { enabledIdx = i; break; }
  }
  if (enabledIdx === -1) return false;

  // Inline list form: enabled: [a, zalo-platform, b]
  const inline = lines[enabledIdx].match(/^(\s*enabled:\s*)\[(.*)\]\s*$/);
  if (inline) {
    const items = inline[2].split(",").map((s) => s.trim()).filter(Boolean);
    const kept = items.filter((s) => s !== "zalo-platform" && s !== "'zalo-platform'" && s !== '"zalo-platform"');
    if (kept.length === items.length) return false; // wasn't present
    lines[enabledIdx] = `${inline[1]}[${kept.join(", ")}]`;
    fs.writeFileSync(cfgPath, lines.join("\n"));
    return true;
  }

  // Block list form: a "- zalo-platform" line below enabled:.
  for (let j = enabledIdx + 1; j < lines.length; j++) {
    if (/^\s*-\s*['"]?zalo-platform['"]?\s*$/.test(lines[j])) {
      lines.splice(j, 1);
      fs.writeFileSync(cfgPath, lines.join("\n"));
      return true;
    }
    if (/^\s*-\s/.test(lines[j])) continue; // another list item
    if (lines[j].trim() === "") continue;   // blank line within the list
    break; // non-list, non-blank line ends the list
  }
  return false;
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
removeHermesPlugin();
if (PURGE) purgeCredentials();
console.log("\nDone. (The bridge files themselves were left in place.)");

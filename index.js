"use strict";

// Signal (signal-cli) adapter for emacs-messenger-bridge.
//
// Relays:
//   Signal incoming text   -> <bridge>/inbox/   (channel "signal")
//   <bridge>/outbox/ (channel "signal") -> signal-cli send
//
// Uses signal-cli in JSON-RPC mode over stdio: a persistent process that
// emits `receive` notifications for incoming messages and accepts `send`
// requests. Link once (npm run link) so signal-cli holds the account.
//
// Config (.env, see .env.example):
//   MESSENGER_BRIDGE_DIR  bridge root (MUST match messenger-bridge.el)
//   SIGNAL_ACCOUNT        your Signal number, +E.164 (the linked account)
//   SIGNAL_CLI            signal-cli binary (default "signal-cli")
//   SIGNAL_CONFIG         signal-cli config dir (optional, --config)
//   SIGNAL_ALLOWED        comma-separated sender numbers to RELAY inbound from
//                         (empty = relay nothing; senders are logged so you can
//                         discover and whitelist them)
//   SIGNAL_POLL_MS        outbox poll interval ms (default 500)

const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { Bridge } = require("./lib/bridge");

// Minimal .env loader (no dependency).
(function loadDotenv() {
  try {
    const fs = require("fs");
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  } catch (e) {
    /* no .env */
  }
})();

const BRIDGE_DIR =
  process.env.MESSENGER_BRIDGE_DIR ||
  path.join(os.homedir(), ".emacs.d", "messenger-bridge");
const SIGNAL_CLI = process.env.SIGNAL_CLI || "signal-cli";
const ACCOUNT = process.env.SIGNAL_ACCOUNT || "";
const CONFIG = process.env.SIGNAL_CONFIG || "";
const ALLOWED = (process.env.SIGNAL_ALLOWED || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const POLL_MS = parseInt(process.env.SIGNAL_POLL_MS || "500", 10);

if (!ACCOUNT) {
  console.error("[sig] SIGNAL_ACCOUNT not set (your linked +E.164 number)");
  process.exit(1);
}

const bridge = new Bridge(BRIDGE_DIR);
let rpcId = 0;
let proc = null;
let restartTimer = null;
let restartAttempts = 0;

function cliArgs(extra) {
  const a = [];
  if (CONFIG) a.push("--config", CONFIG);
  a.push("-a", ACCOUNT);
  return a.concat(extra);
}

function start() {
  console.log(`[sig] starting signal-cli jsonRpc for ${ACCOUNT}`);
  console.log(`[sig] bridge dir: ${BRIDGE_DIR}`);
  if (ALLOWED.length === 0) {
    console.log(
      "[sig] WARNING: SIGNAL_ALLOWED empty — no inbound relayed. Message this " +
        "account from your phone; the sender number is logged to whitelist."
    );
  } else {
    console.log("[sig] relaying inbound from:", ALLOWED.join(", "));
  }

  proc = spawn(SIGNAL_CLI, cliArgs(["jsonRpc"]), {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buf = "";
  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  proc.stderr.on("data", (d) => {
    const s = d.toString("utf8").trim();
    if (s) console.error("[sig][cli]", s.slice(0, 200));
  });
  proc.on("exit", (code) => {
    console.error(`[sig] signal-cli exited (code ${code})`);
    if (restartTimer) return;
    const delay = Math.min(2000 * Math.pow(2, restartAttempts), 60000);
    restartAttempts += 1;
    console.log(`[sig] restarting in ${Math.round(delay / 1000)}s`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, delay);
  });

  restartAttempts = 0;

  // Outbound: bridge outbox (channel "signal") -> signal-cli send
  bridge.watchOutbox(
    async (msg) => {
      if (!msg.chat || !msg.text) return;
      send(String(msg.chat), String(msg.text));
    },
    POLL_MS,
    "signal" // only deliver signal messages; leave others for their adapter
  );
}

function send(recipient, text) {
  const req = {
    jsonrpc: "2.0",
    id: String(++rpcId),
    method: "send",
    params: { recipient: [recipient], message: text },
  };
  proc.stdin.write(JSON.stringify(req) + "\n");
  console.log(`[sig] -> ${recipient}: ${text.slice(0, 60)}`);
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return; // non-JSON noise
  }
  if (msg.method !== "receive" || !msg.params) return;
  const env = msg.params.envelope || {};
  const data = env.dataMessage;
  // Only real incoming text (skip receipts, typing, sync of our own messages).
  if (!data || typeof data.message !== "string" || !data.message) return;
  const from = env.sourceNumber || env.source;
  if (!from) return;
  if (ALLOWED.length === 0 || !ALLOWED.includes(from)) {
    console.log(
      `[sig] (not whitelisted) ${from}: ${data.message.slice(0, 40)} ` +
        "— add to SIGNAL_ALLOWED to relay"
    );
    return;
  }
  const id = bridge.writeInbound({
    channel: "signal",
    chat: from,
    text: data.message,
    meta: { name: env.sourceName || null, timestamp: env.timestamp || null },
  });
  console.log(`[sig] <- ${from}: ${data.message.slice(0, 60)} (inbox ${id})`);
}

start();

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
const EXPORT_CONTACTS =
  (process.env.SIGNAL_EXPORT_CONTACTS || "true") !== "false";
const CONTACTS_MS = parseInt(process.env.SIGNAL_CONTACTS_MS || "1800000", 10);

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

  // Pull contacts shortly after connect, then refresh periodically.
  if (EXPORT_CONTACTS) {
    setTimeout(requestContacts, 3000);
    setInterval(requestContacts, Math.max(CONTACTS_MS, 60000));
  }

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

// --- contacts export -----------------------------------------------------
// Pull the linked account's contacts over the SAME jsonRpc connection (so we
// never fight signal-cli's account lock) and write them, normalized, to
// <bridge>/contacts/signal.json. The bridge merges all channels on `e164`.
const sigContacts = new Map(); // +E.164 -> name
let contactsReqId = null;
let contactsTimer = null;

function requestContacts() {
  if (!EXPORT_CONTACTS || !proc || !proc.stdin.writable) return;
  contactsReqId = String(++rpcId);
  try {
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: contactsReqId, method: "listContacts" }) +
        "\n"
    );
  } catch (e) {
    console.error("[sig] listContacts request:", e.message);
  }
}

function isE164(s) {
  return typeof s === "string" && /^\+\d{6,15}$/.test(s);
}

function flushContacts() {
  if (!EXPORT_CONTACTS || contactsTimer) return;
  contactsTimer = setTimeout(() => {
    contactsTimer = null;
    const records = [];
    for (const [id, name] of sigContacts) {
      // Only a real +E.164 is a number the bridge can merge on; a UUID/username
      // identity stays channel-local (e164 null, keyed by its handle).
      records.push({
        e164: isE164(id) ? id : null,
        handle: id,
        name: name || null,
      });
    }
    try {
      bridge.writeContacts("signal", records);
      console.log(
        `[sig] contacts: ${records.length} exported -> contacts/signal.json`
      );
    } catch (e) {
      console.error("[sig] contacts write:", e.message);
    }
  }, 1500); // debounce bursts
}

function ingestContacts(list) {
  if (!Array.isArray(list)) return;
  let changed = false;
  for (const c of list) {
    if (!c) continue;
    // Identifier: prefer the phone number, else the ACI/UUID (number-private
    // contacts). Never invent a number — a UUID is a valid stable identity and
    // is exported channel-local (see flushContacts).
    const id =
      c.number ||
      c.uuid ||
      c.aci ||
      (c.address && (c.address.number || c.address.uuid)) ||
      null;
    if (!id) continue;
    const name =
      c.name ||
      c.profileName ||
      (c.profile && (c.profile.givenName || c.profile.name)) ||
      sigContacts.get(id) ||
      null;
    if (sigContacts.get(id) !== name) {
      sigContacts.set(id, name);
      changed = true;
    }
  }
  if (changed) flushContacts();
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return; // non-JSON noise
  }
  // listContacts response: no `method`, carries our request id + result array.
  if (contactsReqId && msg.id === contactsReqId && Array.isArray(msg.result)) {
    ingestContacts(msg.result);
    return;
  }
  if (msg.method !== "receive" || !msg.params) return;
  const env = msg.params.envelope || {};
  const data = env.dataMessage;
  // Only real incoming text (skip receipts, typing, sync of our own messages).
  if (!data || typeof data.message !== "string" || !data.message) return;
  // Prefer the phone number (signal-cli resolves it locally for known
  // contacts); fall back to the explicit ACI/UUID for number-private senders,
  // never the ambiguous `source'. Either way the same sender maps to the same
  // stable identity, so a reply is never seen as a different person.
  const from = env.sourceNumber || env.sourceUuid || env.source;
  if (!from) return;
  // Learn a contact name from whoever messages us (enrichment, any sender);
  // ingestContacts keeps a UUID identity channel-local (no fake e164).
  if (env.sourceName) ingestContacts([{ number: from, name: env.sourceName }]);
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

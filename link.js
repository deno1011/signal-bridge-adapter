"use strict";

// One-time linking: register signal-cli as a LINKED DEVICE of your existing
// Signal account (no new number). Runs `signal-cli link`, shows the device-link
// URI as a QR; scan it in Signal ▸ Settings ▸ Linked Devices ▸ Link New Device.
// The process stays up until linking completes.

const { spawn } = require("child_process");
const qrcode = require("qrcode-terminal");

const SIGNAL_CLI = process.env.SIGNAL_CLI || "signal-cli";
const CONFIG = process.env.SIGNAL_CONFIG || "";
const NAME = process.env.SIGNAL_DEVICE_NAME || "emacs-bridge";

const args = [];
if (CONFIG) args.push("--config", CONFIG);
args.push("link", "-n", NAME);

console.log(`Linking via: ${SIGNAL_CLI} ${args.join(" ")}\n`);
const proc = spawn(SIGNAL_CLI, args, { stdio: ["inherit", "pipe", "inherit"] });

let shown = false;
let buf = "";
proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  const m = buf.match(/((?:sgnl:\/\/linkdevice|tsdevice:)[^\s]+)/);
  if (m && !shown) {
    shown = true;
    console.log("\nScan this in Signal ▸ Settings ▸ Linked Devices ▸ Link New Device:\n");
    qrcode.generate(m[1], { small: true });
    console.log("\n(waiting for the link to complete…)\n");
  }
});

proc.on("exit", (code) => {
  if (code === 0) {
    console.log(
      "\n✓ Linked. signal-cli now holds your account. Set SIGNAL_ACCOUNT to your\n" +
        "  Signal number in .env, then run the adapter (npm start)."
    );
  } else {
    console.error(`\nsignal-cli link exited with code ${code}.`);
  }
});

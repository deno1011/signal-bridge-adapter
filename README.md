# signal-bridge-adapter

A **Signal adapter** for
[emacs-messenger-bridge](https://github.com/deno1011/emacs-messenger-bridge),
built on [signal-cli](https://github.com/AsamK/signal-cli). It links Signal as
a **secondary device** of your existing account and relays messages to/from the
bridge's file protocol, so Emacs — and the agent (EAR) — can talk Signal.

It shares ONE bridge directory with the WhatsApp adapter: each adapter only
handles messages whose `channel` matches (`signal` here / `whatsapp` there), so
the agent sees a **unified inbox** and replies with
`(messenger-send CHAT TEXT "signal")` or `"whatsapp"`.

```
 Signal ──▶ signal-cli ──▶ <bridge>/inbox/  (channel "signal")  ──▶ Emacs / EAR
 Signal ◀── signal-cli ◀── <bridge>/outbox/ (channel "signal")  ◀── Emacs / EAR
```

Signal is far more tolerant of third-party clients than WhatsApp (signal-cli is
widely used), so the ban risk is low — but it is still unofficial.

## Requirements

- Node.js ≥ 18
- `signal-cli` (`brew install signal-cli` — pulls a JRE)
- A running `emacs-messenger-bridge` (same bridge dir as the WhatsApp adapter)
- Your phone with Signal, to scan the link QR once

## Setup

```bash
npm install
cp .env.example .env          # set MESSENGER_BRIDGE_DIR + SIGNAL_ACCOUNT
```

### 1. Link as a secondary device (no new number)

```bash
npm run link                  # prints a QR
```

Scan it in **Signal ▸ Settings ▸ Linked Devices ▸ Link New Device**. When it
completes, signal-cli holds your account. Set `SIGNAL_ACCOUNT` in `.env` to your
Signal number (+E.164).

### 2. Run

```bash
npm start
```

With `SIGNAL_ALLOWED` empty, nothing inbound is relayed — message the account
from your phone; the adapter logs the sender number. Put it into
`SIGNAL_ALLOWED` and restart. Now only that chat is relayed.

### 3. Background service (launchd)

Edit and use `launchd/com.deno1011.signal-bridge.plist` (RunAtLoad + KeepAlive),
copy to `~/Library/LaunchAgents/`, `launchctl load`. See the WhatsApp adapter
README for the same pattern.

## How it maps to the bridge

| Direction | Signal | Bridge message |
|---|---|---|
| inbound | text from a whitelisted sender | `inbox/*.json` `{channel:"signal", chat:<+number>, text, meta:{name, timestamp}}` |
| outbound | signal-cli `send` (JSON-RPC) | `outbox/*.json` with `channel:"signal"` → moved to `sent/` |

`chat` is the Signal **+E.164 number**; the agent replies to the same `chat`.
Text only for now.

## Outbound guardrails

The same Emacs-side guardrails apply (they live in `messenger-bridge.el`):
`messenger-send` refuses an unapproved recipient and rate-limits — so the agent
cannot message arbitrary Signal contacts without your approval.

## License

MIT. See [LICENSE](LICENSE).

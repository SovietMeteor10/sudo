# Privacy

This is the inventory of what sudo knows about you, what it doesn't, what it stores, how long, and what you control.

For the protocol-level threat model, see `TRUST_MODEL.md`. For the audit findings, `SECURITY_AUDIT.md`.

---

## The shape of it

Most messaging apps know who you talk to and when, even when they can't read what you say. sudo is in this category. We can't pretend that's not true. What we can do is be specific about it.

What's encrypted:
- The contents of every chat message
- Attachments (images, files) — uploaded as ciphertext, downloaded as ciphertext, decrypted only on the recipient's device
- The contents of every sync event between your own devices (contacts, drafts, message history, feed subscriptions)
- Your account's private keys (in your browser, locked under your password)

What is not encrypted, because the server has to do something with it:
- Your handle (`@you`) and your public keys
- The fact that "@you sent something to @friend"
- Timestamps (when a message landed, when a device picked it up)
- Public feed posts
- Approximate device-online status (inferred from your queue being polled)

---

## What the server stores

Every piece of data the server keeps has a purpose, a retention bound, and a deletion rule. This section lists all of it.

### Your identity

- Your handle, your public keys, the timestamp of your registration, your declared "home node" URL.
- A short text bio, if you've set one (max 280 characters).

Stored until you delete the account.

### Pending messages

- For each message addressed to you: an encrypted blob, the sender's handle, your handle, a creation time, and an expiry time.

Deleted when your device confirms receipt. Auto-expires after 72 hours if your device never picks it up.

### Encrypted device-sync events

- For each cross-device action you take (added a contact, deleted a draft, marked a message read): an encrypted blob, your account ID, the originating device ID, a sequence number, and a timestamp.

Each event stays in the log until every paired device has acknowledged it, plus a short grace period. Long-term retention is bounded by a watermark: once all your devices say "I've seen up to seq N," anything below N is purged.

### Device list

- For each device you've linked: a device ID, a device public key, a friendly name (e.g. "iPhone"), trust state (active/revoked), and the timestamp you signed it in.

Stored until you revoke. Revoked devices stay in the list (marked revoked) so you can see your own history.

### Feed posts you've published

- For each public/connections/close post: the post ID, your handle, the body (encrypted for non-public visibility), the visibility tier, and a signature.

Stored until you delete the post. Public posts may be cached by visitors' browsers.

### Subscriptions and connections

- Who you follow (their canonical IDs), what your relationship tier with them is (unknown / known / close / blocked).

Stored until you remove them.

### Push subscription endpoints

- For each device that wants OS-level push notifications: the URL of the push provider (FCM/Apple/Mozilla/Microsoft), a couple of crypto fields the provider needs to deliver the push.

Stored until you remove it or the provider says the endpoint is gone (HTTP 410).

### Rate-limit counters

- Recent requests per IP and per identity, kept in memory for ~1 minute, then dropped.

Not persisted across server restarts.

### What's NOT stored

- Your password — not as plaintext, not as a hash, not ever.
- Your private keys.
- The plaintext of any message.
- The plaintext of any sync event payload.
- Read receipts, draft contents, typing state — all client-side or ephemeral.
- Your IP address — not logged with your handle. (HTTP access logs may contain IPs in operator-defined logs; that's a server-config thing, not a sudo data structure.)

---

## What you control

You can:

- **Export a backup** at any time. `.sudo-backup.json` is an encrypted file containing your account that you can carry to a new device.
- **Reset this browser.** Wipes the local lockbox, signs out, removes pending message queues. Server-side, you stay an account; locally, this browser doesn't know you anymore.
- **Revoke a linked device.** That device's signed requests start getting refused immediately.
- **Delete a feed post.** It's removed from the server. Anyone who already downloaded the post may have a local copy.
- **Block someone.** Their messages stop being delivered to you. The block is enforced server-side.
- **Disable push.** Turn off the OS notification at the device, or remove the subscription via the settings panel.

What you do NOT have on this version:

- A "remote wipe" button for a lost device. The closest is revocation, which prevents future server-side access but doesn't reach into the lost device.
- A "delete my account" button that purges all server traces. Today it's manual — `npm run dev:reset` from the server is the operator-side wipe. A user-facing delete-everything button is a planned addition.
- Selective metadata redaction beyond what the protocol already does.

---

## Notifications

When a message arrives for you and you have a push subscription registered, the server tells your OS push provider (FCM, Apple, Mozilla, Microsoft) to wake your phone with a small payload. That payload contains:

- A conversation hint (the sender's canonical ID) — enough for your device to look up which chat to open.
- The sender's handle (`@friend`).
- An unread count.

It does **not** contain the message body. The body is encrypted in the queue; only your phone, after waking up, can decrypt it.

The push providers (Google/Apple/Mozilla/Microsoft) see the encrypted payload they're carrying. They see who it's going to, when, and how often. Their privacy policies apply to that visibility. Choosing not to install the PWA, or disabling notifications, removes them from the loop.

---

## Connections to other services

sudo on its own does not call out to any third-party service. No analytics. No tracking pixels. No external fonts. No CDN. The HTTP requests your browser makes go to:

- The sudo server you signed up on.
- Your OS push provider, if you enabled notifications.

That's it. If you load the page over Tor, even those connections happen over Tor.

---

## Tor

sudo can be served over a `.onion` address. When you connect that way:

- The server doesn't see your IP at all (it sees a Tor exit's IP if you're a clearnet client to an onion gateway, or a Tor circuit endpoint if you're a Tor-Browser client).
- The client never makes a request to a clearnet host. Every URL it generates is built from the origin you connected to.
- An indicator in the UI shows "connected over Tor."

See `TOR_DEPLOY.md` for the operator side and `SECURITY_AUDIT.md` for what was checked.

---

## Children / age

sudo has no age gate. The cryptographic protections do not change with the user's age. If you are responsible for a child's account, you are responsible for the device, the backup, and the people they message — the same way you'd be responsible for any other end-to-end-encrypted tool they use.

---

## Government requests

If a sudo node operator receives a lawful request for user data, they can hand over what's in their database. Specifically:

- Account metadata (handle, public keys, home node URL, bio if set).
- Device list with timestamps.
- Queued ciphertext (if any is pending).
- Counts.

They cannot hand over message contents, private keys, passwords, or sync log payloads — they don't have those.

If you run your own node, you'll receive any such requests directly. If you use a node someone else operates, you're trusting them with the metadata above. There is no centralized sudo authority; each node is a separate trust domain.

---

## Things we want to do but haven't yet

- **Pure local-only operation** — running sudo entirely offline, with messages relayed through a sneakernet.
- **Metadata-minimizing relays** — onion-style routing where even the recipient handle is encrypted, leaving the relay with only enough information to forward the next hop.
- **Account deletion that actually scrubs.** The server today deletes when a device confirms receipt; explicit "delete my whole account" is operator-side.
- **Per-message expiry under the recipient's control** — vanishing messages that the recipient can choose to keep.

Each of these is a tradeoff. They're not on the current version's path but they're on the project's list.

---

## How to verify any of this

Run a node yourself. The whole codebase is open. Open the SQLite file. Run the smoke suite. Read the route handlers. Inspect a network trace.

The opposite of "trust us" is "check us." We've tried to make checking easy.

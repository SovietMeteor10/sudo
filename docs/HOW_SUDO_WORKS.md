# How sudo works

A plain explanation of what happens when you use sudo. No protocol jargon, no math. If you want the technical detail, see `TRUST_MODEL.md` and `PRIVACY.md`.

---

## In one paragraph

sudo is a chat and feed app where your account lives on your devices, not on a server. The server passes messages along and stores them only as scrambled blocks of bytes it can't read. When you write to a friend, your phone encrypts the message so only your friend's phone can unlock it. The server never sees your password and never holds a master key. If everything in the data centre vanished tomorrow, your messages would still be readable on the devices that received them.

---

## Making an account

When you tap "sign up," everything important happens in your browser:

- Your browser makes a pair of cryptographic keys — one stays secret on your device, one is public.
- Your browser also makes a password-protected lockbox and puts the secret key inside.
- The lockbox goes into your browser's local storage. **It never leaves your device.**
- The public key, along with your handle, goes to the server. That's your "identity document."

The server now knows your handle (`@you`) and your public key. That's all. It does not know your password, your secret key, or anything about you.

When you sign in later, your browser asks the server for a one-time challenge, signs it with your secret key, and the server checks the signature against the public key it remembers. You never type a password into the server.

---

## What a "device" is

A device is a browser on a phone, tablet, or computer where you've signed in and unlocked your lockbox. Each device has its own internal device key, distinct from your account key. You can have several devices linked to one account.

**Linking a new device** means handing the lockbox to another browser using a one-time passcode you generate from a device you already trust. The handoff itself is wrapped in two layers of encryption (the passcode and your account password); the server only sees ciphertext.

**Revoking a device** means telling the server "this device is no longer me." The server starts rejecting that device's requests immediately. Anything the revoked device already had locally stays on it — revocation is about what the server will accept going forward.

---

## Sending a message

Say you message `@friend`:

1. Your phone looks up `@friend`'s public key from the server.
2. Your phone uses that public key to encrypt the message so only `@friend`'s phone can decrypt it.
3. Your phone signs the encrypted blob so the server (and `@friend`) can verify it really came from you.
4. The server stores the blob in `@friend`'s queue and notifies their device.
5. When `@friend`'s phone picks it up, it decrypts locally and shows the message.
6. `@friend`'s phone tells the server "got it" — the server deletes the blob.

At no point does the server see what the message says.

---

## Receiving a message

Your phone polls the server periodically for new messages addressed to you. Each one is encrypted and signed. Your phone:

1. Asks the server for your queue (this is an authenticated request — only your device can ask).
2. Pulls down the encrypted blobs.
3. Decrypts each one locally.
4. Shows them in the chat.
5. Tells the server "delivered" — the server then deletes them.

If your phone is offline, blobs sit in the queue for up to a few days before the server gives up and expires them.

---

## What "signing out" means

Signing out wipes the unlocked keys from your browser's running memory. The encrypted lockbox stays in local storage (so you can sign back in later with your password). Push subscriptions and any open queues on this device are disconnected from the server.

If you want to leave NO trace on this device, use "reset this browser" — that deletes the lockbox itself. You'll need a backup file or another linked device to get your account back on this device.

---

## What happens if you lose all your devices

The encrypted lockbox lives on your devices. If every device is gone, the lockbox is gone too — and the server can't help, because the server never had a copy.

You have two ways to prevent this from being permanent:

- **Backup file.** Export `.sudo-backup.json` from a device you trust. Keep it somewhere safe (a password manager, an encrypted drive, a USB stick in a drawer). To restore, upload it to any browser and enter your password.
- **Linked devices.** If you have your phone and laptop both signed in, losing one is fine — you still have the other.

If you have neither, your account is lost. We can't recover it; nobody can. This is the cost of the server not knowing your secret.

---

## The feed

sudo also has a public feed (think a quiet social posting layer, not a high-velocity timeline). Feed posts are signed by you with a feed-specific key. Anyone who can reach the server can read public posts. Posts marked "connections only" or "close" require the viewer to be in the right tier of your contact list — those visibility checks are enforced by the server using signed requests.

---

## What the server gives back

When you ask the server something — your queue, your feed, who's followed you — your phone signs the request first. The server checks that signature against the identity it expects, then answers. If the signature doesn't match, the server refuses. There is no path where a stranger can request your queue, set your relationships, or pretend to be you.

(There used to be one before this hardening pass. There isn't anymore.)

---

## What's coming

- **Tor / onion access** — sudo can already serve over a `.onion` address; once a public onion is provisioned, you can use sudo without revealing your IP to the server.
- **Federation** — eventually, an account on one sudo server should be able to message an account on another. Not done yet.
- **Hardware-backed keys** — using a passkey or hardware security key to unlock the lockbox, instead of a passphrase. Future work.

---

## Where the rest of the detail lives

- `TRUST_MODEL.md` — exactly what the server can and can't see, and why.
- `PRIVACY.md` — the metadata that does exist, how long it lives, and what you control.
- `SECURITY.md` — the protocol surface in technical language.
- `SECURITY_AUDIT.md` — the most recent independent code review and its findings.

# Trust model

This document is the answer to: *"if I run sudo, what do I have to trust, and what can I check?"*

It's meant to be readable. The deep protocol detail is in `SECURITY.md`.

---

## The short version

You trust the device you're using. You do not trust the server. You partially trust the people you message.

Concretely:

- The server **passes things along and stores them**. It does not read message contents, does not know your password, and does not hold any key that could unlock your account.
- Your **device** holds the only copy of your account's secret key. It signs everything you do and decrypts everything you receive.
- The **people you message** see your messages in plaintext because they decrypted them. That's normal — they're who you sent them to. But it does mean a friend with a screenshot button still has a screenshot button.

---

## What the server CAN see

Everything in this list is unavoidable for the server to do its job. We document it honestly rather than pretend it's not visible.

- **Your handle and public key.** This is how anyone reaches you. It's deliberately public.
- **Who is messaging whom.** The server has to route messages, so it sees envelope-level "sender → recipient" pairs. The *contents* are encrypted. The fact that two handles are talking is not.
- **Approximate timing.** The server logs when a message lands and when it gets picked up. Not the contents.
- **Public feed posts.** These are intentionally public — anyone can read them, including the server.
- **Your device list.** The handles you've paired with each other (e.g. "@you's iPhone" + "@you's laptop"). Used to gate which devices are allowed to receive your sync log.
- **Counts.** Number of messages queued, number of devices, etc. Operator-visible aggregates for capacity planning.

---

## What the server CANNOT see

- **Your password.** It is never sent over the wire. Your browser uses it to unlock the local lockbox and that's it.
- **Your secret key.** Same — lives only in your browser's encrypted storage.
- **The contents of your messages.** Every chat envelope is encrypted to the recipient's key. The server holds opaque ciphertext.
- **The contents of your sync log between your own devices.** Things like "I added @bob to my contacts" sync between your phone and laptop through the server, but the payload is encrypted with a key only your devices share.
- **Your contact tier for any peer.** "@alice is a close friend, @bob is blocked, @carol is unknown" — that lives client-side and syncs encrypted between your devices.
- **Anything you've deleted.** Deletion is enforced at the relay: when your device confirms it stored a message, the server's copy is wiped.

---

## What linked devices mean

A linked device is a second browser (phone, tablet, another computer) where you've taken your account.

- Each device has its own **device key**, separate from your account's master key.
- The first device signs a "membership" for each new device using your master key. This is what the server checks to decide whether a request from a given device is authentic.
- Devices share the encrypted lockbox during pairing. After pairing, the new device unlocks it with your password.
- Each device polls the server independently for messages addressed to your handle.
- A "sync log" between your devices keeps contacts, drafts, message history, and feed subscriptions consistent. The log is encrypted with a key only your devices share.

You can revoke any device from any other device. Revocation is a signed statement that says "this device is no longer authorized." The server stops accepting that device's requests immediately. Anything the revoked device already had locally remains on that device — revocation is about future access through the server, not retroactive removal.

---

## What happens if a device is lost

The lost device still has whatever your account had stored locally. If it falls into someone's hands:

- They cannot use the account without your password — the lockbox is encrypted.
- They cannot trick the server into thinking they are you — every action needs a signature you'd have had to make.
- They might still see whatever was visible on screen the moment you lost it (notification previews, recent messages).

What you should do:

1. **Revoke the device** from another one you still have. The server will reject its future requests.
2. **Change your password** by exporting a backup file with a new password (the old encrypted lockbox stays encrypted under the old password; future devices won't be using the old one).

If you've lost all your devices and have no backup file: the account is gone. The server cannot recover it because the server never had the means to.

---

## Why every request is signed

When your phone asks the server "give me my messages," your phone signs that request with a private key. The server checks the signature against the public key it has on file for your handle. If the signature is missing, expired, replayed, or made by a key that isn't yours, the server refuses.

This is **how the server knows it's really you.** There is no session cookie that, if stolen, lets someone else act as you. There is no password that, if intercepted, gives someone access. Every action is independently verifiable.

This was put in place during Phase 14 of development. Before that, several routes accepted "I am @you" as a claim with no proof. The fix was to require a per-request signature on every operation that mutates trust state. See `SECURITY_AUDIT.md` for the full audit and `SECURITY.md` for the wire format.

---

## What the operator (whoever runs the server) can do

The person running the sudo node — operator-of-record for this particular install — has some powers it's worth being honest about:

- They can see everything in the "server CAN see" list above.
- They can shut down the service entirely.
- They can read the database. The contents of messages are encrypted blobs to them too, but they can see the routing graph.
- They can **decline to deliver** specific messages. The server logs this; the recipient's device would notice messages missing.
- They cannot **forge** messages from you. Every message has your signature.
- They cannot **decrypt** anything they shouldn't be able to read.

If you don't trust the operator at all, run your own sudo node. The project is open source. A single small VPS will host an instance.

---

## Federation (not yet)

Right now, an account on one sudo node only talks to other accounts on the same node. Federation — accounts on different nodes messaging each other — is on the roadmap but unimplemented.

When it lands, the trust shape will change:

- Your **origin** node still knows the same things it does today.
- Other federated nodes will see your handle, your public key, and the metadata of any messages you exchange with their users.
- The contents of those messages will remain end-to-end encrypted between your device and the recipient's device. No federated node — not your origin, not the recipient's — sees plaintext.

Federation will not add a "super-node" or central registry. Each node is its own trust boundary.

---

## Things that are genuinely hard

A few honest weak points in the model. These are not bugs; they're inherent to the threat model.

- **Compromised device.** If someone unlocks your phone, they are you. End-to-end encryption protects messages in transit and at rest in the server's databases — it cannot protect plaintext that's already on a screen the attacker controls.
- **Compromised operator.** A malicious operator can see metadata, delay messages, deny service, and learn things about who-talks-to-whom. They cannot forge messages or read contents. If this matters to you, run your own node.
- **Compromised JavaScript delivery.** The sudo client is JavaScript downloaded from the server. A malicious operator could ship a backdoored client to a specific user. There is no automatic protection against this — protection comes from third-party audits, reproducible builds, and (eventually) signed bundles. Today this requires trust in the operator and code review.
- **Metadata is not content but it isn't nothing.** Who you talk to, when, how often — that's a meaningful trail. We minimize it where we can but we can't eliminate routing.
- **Lost backup, lost account.** Cryptographic privacy and recoverable accounts are in tension. We chose privacy. If you don't keep a backup, you don't get a recovery option.

---

## What you can check

Without trusting our word for any of this:

- The source is open. `git clone` the repo and read it.
- `docs/SECURITY_AUDIT.md` is the most recent code-level audit and lists every gap that's been found and fixed.
- The server's database is SQLite. If you run your own node, you can `sqlite3` the file and confirm message ciphertext is opaque.
- Every signed request goes through `src/identity/request-auth.ts`. Read that one file to understand the auth invariant.
- The encryption code is in `src/web/client/crypto/`. Two ~300-line files cover everything.
- Run the smoke suite (`npm run smoke:*`) — every claim in this document is mirrored by a test.

The fewer things you have to take on faith, the better. We've tried to make as many of those things as possible inspectable.

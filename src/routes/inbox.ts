import { Router } from "express";
import { db } from "../db.js";
import { getIdentityByCanonicalId } from "../registry.js";

export const inboxRouter = Router();

type MessageRequest = {
  from?: unknown;
  ciphertext?: unknown;
  nonce?: unknown;
  signature?: unknown;
};

type MessageRow = {
  id: number;
  sender: string;
  ciphertext: string;
  nonce: string;
  signature: string;
  received_at: string;
};

inboxRouter.post("/inbox/:canonicalId", (request, response) => {
  const identity = getIdentityByCanonicalId(request.params.canonicalId);

  if (!identity) {
    response.status(404).json({ error: "inbox_not_found" });
    return;
  }

  const body = request.body as MessageRequest;
  if (
    typeof body.from !== "string" ||
    typeof body.ciphertext !== "string" ||
    typeof body.nonce !== "string" ||
    typeof body.signature !== "string"
  ) {
    response.status(400).json({ error: "encrypted_blob_required" });
    return;
  }

  // Do not log payloads here. The server is only a blind encrypted blob store.
  db.prepare(`
    INSERT INTO encrypted_messages (
      canonical_id,
      sender,
      ciphertext,
      nonce,
      signature,
      received_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    identity.canonicalId,
    body.from,
    body.ciphertext,
    body.nonce,
    body.signature,
    new Date().toISOString()
  );

  response.status(202).json({ ok: true });
});

inboxRouter.get("/inbox/:canonicalId", (request, response) => {
  const identity = getIdentityByCanonicalId(request.params.canonicalId);

  if (!identity) {
    response.status(404).json({ error: "inbox_not_found" });
    return;
  }

  // UNSAFE DEV-ONLY ENDPOINT: useful for local message flow testing.
  // A real deployment should authenticate the recipient and return ciphertext
  // only over their private retrieval channel.
  const rows = db
    .prepare(`
      SELECT id, sender, ciphertext, nonce, signature, received_at
      FROM encrypted_messages
      WHERE canonical_id = ?
      ORDER BY received_at DESC
    `)
    .all(identity.canonicalId) as MessageRow[];

  response.json({
    warning: "unsafe_dev_only_ciphertext_listing",
    messages: rows.map((row) => ({
      id: row.id,
      from: row.sender,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      signature: row.signature,
      received_at: row.received_at
    }))
  });
});

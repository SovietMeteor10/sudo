// Message-reaction slice of trusted-device sync.
//
// Two propagation paths converge at upsertLocalMessageReactionMonotonic:
//
//   1. SAME-OWNER (linked devices of the reactor or recipient):
//        message_reaction.upsert sync event. The encrypted_payload
//        carries the full LocalMessageReaction-shaped record. The
//        slice is `message_reaction`. Receiver-side projection is
//        idempotent monotonic.
//
//   2. CROSS-USER (chat peer reacting to my message, or me reacting
//        to theirs): wrapped inside the existing relay envelope as
//        a special ciphertext_scheme `sudo_reaction_v1`. Handled in
//        relay-local.ts on inbox poll — that path decrypts and
//        funnels through `applyIncomingReactionFromRelay` below.
//
// Sender's own UI update happens via the local store write (which
// fires broadcastLocalStateChange("messages", owner) and triggers a
// re-render of the chat-popup body).

import { activeAccount, buildAndPostSyncEvent, registerSliceProjector } from "./coordinator.js";
import type { BrowserCryptoAccount } from "../crypto/key-storage.js";
import { upsertLocalMessageReactionMonotonic } from "../local/local-store.js";
import type { LocalMessageReaction } from "../local/local-types.js";
import { signRelayEnvelope } from "../crypto/signing.js";

// The 5-emoji set the UI exposes. Enforce server-side too in case a
// later UI variant ships a different palette before the projector
// catches up.
export const REACTION_EMOJI_SET = ["👍", "❤️", "😂", "😮", "😢"] as const;
export type ReactionEmoji = typeof REACTION_EMOJI_SET[number];
export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (REACTION_EMOJI_SET as readonly string[]).includes(value);
}

type ReactionSyncPayload = {
  owner_canonical_id: string;
  relay_message_id: string;
  reactor_canonical_id: string;
  emoji: string;
  updated_at: string;
  removed_at?: string;
};

function reactionToPayload(reaction: LocalMessageReaction): ReactionSyncPayload {
  const payload: ReactionSyncPayload = {
    owner_canonical_id: reaction.owner_canonical_id,
    relay_message_id: reaction.relay_message_id,
    reactor_canonical_id: reaction.reactor_canonical_id,
    emoji: reaction.emoji,
    updated_at: reaction.updated_at
  };
  if (typeof reaction.removed_at === "string") payload.removed_at = reaction.removed_at;
  return payload;
}

function payloadToReaction(p: Partial<ReactionSyncPayload>, fallbackOwner: string): LocalMessageReaction | null {
  if (
    typeof p.relay_message_id !== "string"
    || typeof p.reactor_canonical_id !== "string"
    || typeof p.updated_at !== "string"
    || typeof p.emoji !== "string"
  ) return null;
  const owner = typeof p.owner_canonical_id === "string" ? p.owner_canonical_id : fallbackOwner;
  const out: LocalMessageReaction = {
    owner_canonical_id: owner,
    relay_message_id: p.relay_message_id,
    reactor_canonical_id: p.reactor_canonical_id,
    emoji: p.emoji,
    updated_at: p.updated_at
  };
  if (typeof p.removed_at === "string") out.removed_at = p.removed_at;
  return out;
}

// User-driven write path. Saves locally first (so the UI reflects
// the change immediately), then fans out to other linked devices.
// The cross-USER propagation is handled by the relay envelope
// emitter in main.ts; this function only handles same-owner sync.
export async function notifyReactionUpsert(reaction: LocalMessageReaction): Promise<{ written: boolean }> {
  const result = await upsertLocalMessageReactionMonotonic(reaction);
  if (!result.written) return { written: false };
  const account = activeAccount();
  if (account === null || account.canonical_id !== reaction.owner_canonical_id) {
    return { written: true };
  }
  void buildAndPostSyncEvent(
    "message_reaction",
    "message_reaction.upsert",
    reactionToPayload(reaction)
  );
  return { written: true };
}

// Called by the relay inbox processor when an incoming envelope is
// tagged with the reaction ciphertext_scheme. We get the decrypted
// reaction payload + a known sender (the relay envelope's
// sender_canonical_id). The owner is whoever's local store is being
// written to — that's the recipient of the relay envelope, which is
// always the local user.
export async function applyIncomingReactionFromRelay(
  ownerCanonicalId: string,
  payload: Partial<ReactionSyncPayload>
): Promise<{ written: boolean }> {
  if (!isReactionEmoji(payload.emoji)) return { written: false };
  const reaction = payloadToReaction(payload, ownerCanonicalId);
  if (reaction === null) return { written: false };
  // Force-owner to the local user so a cross-account event can't
  // overwrite an unrelated row.
  reaction.owner_canonical_id = ownerCanonicalId;
  const result = await upsertLocalMessageReactionMonotonic(reaction);
  if (!result.written) return { written: false };
  // After a peer reacted to our message, we ALSO need to broadcast
  // to our other linked devices via the same-owner sync slice so a
  // second tab / phone sees the aggregate too.
  const account = activeAccount();
  if (account !== null && account.canonical_id === ownerCanonicalId) {
    void buildAndPostSyncEvent(
      "message_reaction",
      "message_reaction.upsert",
      reactionToPayload(reaction)
    );
  }
  return { written: true };
}

// Same-owner projector: linked-device sync of reactions. Idempotent
// monotonic by updated_at.
registerSliceProjector("message_reaction", async (account, event, payload) => {
  if (event.kind !== "message_reaction.upsert") return false;
  const reaction = payloadToReaction(payload as Partial<ReactionSyncPayload>, account.canonical_id);
  if (reaction === null) return false;
  if (reaction.owner_canonical_id !== account.canonical_id) return false;
  if (!isReactionEmoji(reaction.emoji)) return false;
  await upsertLocalMessageReactionMonotonic(reaction);
  return true;
});

// ============================================================
// Cross-user relay envelope emit + receive.
//
// Mirrors the receipt envelope pattern from relay-local.ts: a
// JSON body is base64url-encoded inline with a scheme prefix. The
// relay server never decodes it; only the peer's inbox processor
// does. Real E2E encryption arrives with the same migration that
// finishes the dev-placeholder chat scheme.
// ============================================================

export const REACTION_CIPHERTEXT_SCHEME = "sudo_reaction_v1";

type ReactionEnvelopeBody = {
  relay_message_id: string;
  reactor_canonical_id: string;
  emoji: string;
  updated_at: string;
  removed_at?: string;
};

export function encodeReactionEnvelopeBody(body: ReactionEnvelopeBody): string {
  const json = JSON.stringify(body);
  return `${REACTION_CIPHERTEXT_SCHEME}:${btoa(unescape(encodeURIComponent(json)))}`;
}

export function decodeReactionEnvelopeBody(rawCiphertext: string): ReactionEnvelopeBody | null {
  const prefix = `${REACTION_CIPHERTEXT_SCHEME}:`;
  const payload = rawCiphertext.startsWith(prefix) ? rawCiphertext.slice(prefix.length) : rawCiphertext;
  let decoded: unknown;
  try { decoded = JSON.parse(decodeURIComponent(escape(atob(payload)))); }
  catch { return null; }
  if (decoded === null || typeof decoded !== "object") return null;
  const obj = decoded as Partial<ReactionEnvelopeBody>;
  if (
    typeof obj.relay_message_id !== "string"
    || typeof obj.reactor_canonical_id !== "string"
    || typeof obj.emoji !== "string"
    || typeof obj.updated_at !== "string"
  ) return null;
  const out: ReactionEnvelopeBody = {
    relay_message_id: obj.relay_message_id,
    reactor_canonical_id: obj.reactor_canonical_id,
    emoji: obj.emoji,
    updated_at: obj.updated_at
  };
  if (typeof obj.removed_at === "string") out.removed_at = obj.removed_at;
  return out;
}

// Best-effort cross-user post. Caller already wrote the reaction
// to its own local store; this just announces it to the peer.
export async function postReactionRelayEnvelope(input: {
  senderAccount: BrowserCryptoAccount;
  senderHandle?: string;
  recipientCanonicalId: string;
  recipientHandle?: string;
  reaction: LocalMessageReaction;
}): Promise<{ ok: boolean }> {
  const now = new Date();
  const expires = new Date(now.valueOf() + 24 * 60 * 60 * 1000);
  const body: ReactionEnvelopeBody = {
    relay_message_id: input.reaction.relay_message_id,
    reactor_canonical_id: input.reaction.reactor_canonical_id,
    emoji: input.reaction.emoji,
    updated_at: input.reaction.updated_at
  };
  if (typeof input.reaction.removed_at === "string") body.removed_at = input.reaction.removed_at;
  const envelope = {
    type: "sudo_relay_envelope" as const,
    protocol_version: "0.1.0",
    message_id: crypto.randomUUID(),
    sender_canonical_id: input.senderAccount.canonical_id,
    recipient_canonical_id: input.recipientCanonicalId,
    sender_handle: input.senderHandle,
    recipient_handle: input.recipientHandle,
    ciphertext: encodeReactionEnvelopeBody(body),
    ciphertext_scheme: REACTION_CIPHERTEXT_SCHEME,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    status: "queued_local" as const,
    sender_signature: "dev-placeholder" as string
  };
  // Phase 14 CRIT-1: production rejects dev-placeholder envelopes.
  try {
    envelope.sender_signature = await signRelayEnvelope(
      {
        type: envelope.type,
        protocol_version: envelope.protocol_version,
        message_id: envelope.message_id,
        sender_canonical_id: envelope.sender_canonical_id,
        recipient_canonical_id: envelope.recipient_canonical_id,
        sender_handle: envelope.sender_handle,
        recipient_handle: envelope.recipient_handle,
        ciphertext: envelope.ciphertext,
        ciphertext_scheme: envelope.ciphertext_scheme,
        created_at: envelope.created_at,
        expires_at: envelope.expires_at
      },
      input.senderAccount.identity_key,
      input.senderAccount.identity_key_type
    );
  } catch {
    return { ok: false };
  }
  try {
    const r = await fetch("/api/relay/envelopes", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(envelope)
    });
    return { ok: r.ok };
  } catch {
    return { ok: false };
  }
}

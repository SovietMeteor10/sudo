// Client-side typing-indicator coordinator.
//
// Sender contract:
//   - notifyComposerInput(senderCanonicalId, recipientCanonicalId)
//     is called on every input event in the composer.
//   - First call after a quiet period fires POST /api/typing
//     with typing=true. Subsequent calls within a 3s debounce
//     window are coalesced (no extra POST).
//   - 5s after the last input event with no further activity, OR
//     when the composer is cleared, OR when the chat is closed,
//     stopTyping() fires POST /api/typing with typing=false.
//   - Switching to a different recipient also stops the prior
//     conversation's typing.
//
// Receiver contract:
//   - startReceivingTypingFor(recipientCanonicalId, render) starts
//     a 2s poll loop against GET /api/typing/:recipient.
//   - The render callback is invoked with the list of currently-
//     active sender canonical_ids (server already filters expired
//     entries on read; we additionally drop entries whose
//     expires_at is in the past on the client side as belt+braces).
//
// Privacy:
//   - we never echo our own typing event back to the local view
//     (the page-side already filters since we know our own
//     canonical_id when rendering).
//   - typing state never touches IndexedDB or device_sync_log.

import { fetchTypingForRecipient, postTypingState } from "./api.js";

const SEND_DEBOUNCE_MS = 3_000;
const STOP_AFTER_IDLE_MS = 5_000;
const POLL_INTERVAL_MS = 2_000;

type SenderState = {
  recipient: string;
  lastSentAt: number;
  lastInputAt: number;
  active: boolean;
  stopTimer: number | null;
};

let senderState: SenderState | null = null;

function clearSenderStopTimer(): void {
  if (senderState?.stopTimer !== null && senderState?.stopTimer !== undefined) {
    window.clearTimeout(senderState.stopTimer);
    senderState.stopTimer = null;
  }
}

function scheduleStopTimer(senderCanonicalId: string): void {
  clearSenderStopTimer();
  if (senderState === null) return;
  const recipient = senderState.recipient;
  senderState.stopTimer = window.setTimeout(() => {
    if (senderState?.recipient === recipient && senderState?.active === true) {
      senderState.active = false;
      void postTypingState({
        sender_canonical_id: senderCanonicalId,
        recipient_canonical_id: recipient,
        typing: false
      });
    }
  }, STOP_AFTER_IDLE_MS);
}

// Called on every composer input event. Returns void; never throws.
export function notifyComposerInput(senderCanonicalId: string, recipientCanonicalId: string): void {
  // Switching recipients: tear down the previous indicator first.
  if (senderState !== null && senderState.recipient !== recipientCanonicalId) {
    stopTypingForCurrent(senderCanonicalId);
  }
  const now = Date.now();
  if (senderState === null) {
    senderState = {
      recipient: recipientCanonicalId,
      lastSentAt: 0,
      lastInputAt: now,
      active: false,
      stopTimer: null
    };
  }
  senderState.lastInputAt = now;
  if (!senderState.active || (now - senderState.lastSentAt) >= SEND_DEBOUNCE_MS) {
    senderState.lastSentAt = now;
    senderState.active = true;
    void postTypingState({
      sender_canonical_id: senderCanonicalId,
      recipient_canonical_id: recipientCanonicalId,
      typing: true
    });
  }
  scheduleStopTimer(senderCanonicalId);
}

function stopTypingForCurrent(senderCanonicalId: string): void {
  if (senderState === null) return;
  clearSenderStopTimer();
  if (senderState.active) {
    void postTypingState({
      sender_canonical_id: senderCanonicalId,
      recipient_canonical_id: senderState.recipient,
      typing: false
    });
  }
  senderState = null;
}

// Called when the composer is cleared (e.g., after a successful
// send) or the chat popup is closed. Immediate stop.
export function stopTyping(senderCanonicalId: string): void {
  stopTypingForCurrent(senderCanonicalId);
}

// ============================================================
// Receiver — poll loop + per-conversation render hook
// ============================================================

type ReceiverState = {
  recipientOwn: string;       // my own canonical_id (I am the recipient on the wire)
  peerCanonicalId: string;    // the peer I want typing state from
  pollTimer: number | null;
  render: (active: boolean, peerHandle?: string) => void;
  peerHandle?: string;
};

let receiverState: ReceiverState | null = null;

async function pollOnce(): Promise<void> {
  if (receiverState === null) return;
  const entries = await fetchTypingForRecipient(receiverState.recipientOwn);
  const now = Date.now();
  // Find an entry from this exact peer; ignore self-entries (which
  // shouldn't exist on the wire because the server rejects self-as-
  // recipient, but defense in depth).
  const peer = entries.find((e) =>
    e.sender_canonical_id === receiverState!.peerCanonicalId
    && e.sender_canonical_id !== receiverState!.recipientOwn
    && Date.parse(e.expires_at) > now
  );
  receiverState.render(peer !== undefined, receiverState.peerHandle);
}

export function startReceivingTypingFor(input: {
  ownCanonicalId: string;
  peerCanonicalId: string;
  peerHandle?: string;
  render: (active: boolean, peerHandle?: string) => void;
}): void {
  stopReceivingTyping();
  receiverState = {
    recipientOwn: input.ownCanonicalId,
    peerCanonicalId: input.peerCanonicalId,
    peerHandle: input.peerHandle,
    render: input.render,
    pollTimer: null
  };
  void pollOnce();
  receiverState.pollTimer = window.setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
}

export function stopReceivingTyping(): void {
  if (receiverState === null) return;
  if (receiverState.pollTimer !== null) window.clearInterval(receiverState.pollTimer);
  // Clear the indicator on tear-down so a fast switch doesn't leave
  // a stale "is typing…" line under the previous conversation.
  receiverState.render(false);
  receiverState = null;
}

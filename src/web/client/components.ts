import { mountTextSurface, unmountAllTextSurfaces } from "./rendering/textSurface.js";
import type {
  ChatSummary,
  ConnectionRelationship,
  DiscoveryPostIndex,
  DiscoveryState,
  DeviceSyncEvent,
  FeedPost,
  FeedSubscription,
  IdentityFingerprint,
  IdentityDocument,
  LocalIdentity,
  LookupState,
  TrustedDevice,
  SearchResult,
  SearchState,
  SignupState,
  SigninState,
  SocialNotification,
} from "./types.js";

// Unified feed item used by both the personal stream and the discover
// stream. Either source produces this shape and the same renderer
// draws it, so the two tabs feel like one feed with different sources.
export type ReactionKind = "recommend" | "downrank" | "reply" | "repost";
export type VoteKind = "like" | "dislike" | null;
export type ReactionCounts = {
  recommend: number;
  downrank: number;
  reply: number;
  repost: number;
};
export type EmbeddedFeedItem =
  | {
      unavailable?: false;
      post_id: string;
      author_canonical_id: string;
      author_handle?: string;
      body: string;
      created_at: string;
      // Reposts can wrap reposts. The renderer draws up to 2 visible
      // levels and shows a "view original post" link beyond that.
      embedded_repost?: EmbeddedFeedItem;
    }
  | { unavailable: true };
export type UnifiedFeedItem = {
  post_id: string;
  author_canonical_id: string;
  author_handle?: string;
  body: string;
  created_at: string;
  counts: ReactionCounts;
  vote: VoteKind;
  // For kind="repost", the original post body/author are rendered
  // inside the card so the repost reads as "@me reposted @them: ...".
  repost_of?: EmbeddedFeedItem;
  // For kind="reply" we tag the parent post inline so the reply makes
  // sense in a chronological feed.
  reply_to?: EmbeddedFeedItem;
  kind?: "post" | "repost" | "reply";
  viewer_has_reposted?: boolean;
  // True when the viewer is the normalized original author (own post,
  // or somebody else's repost that traces back to one of yours). The
  // renderer hides the repost button in that case; the server also
  // rejects with cannot_repost_own_post if forced.
  viewer_is_author?: boolean;
};

export type ReactionHandler = (postId: string, kind: ReactionKind) => void;

const ZERO_COUNTS: ReactionCounts = { recommend: 0, downrank: 0, reply: 0, repost: 0 };

const BODY_FONT = '15px "IBM Plex Mono", "SFMono-Regular", Menlo, Consolas, monospace';

export function renderIdentityPane(root: HTMLElement, identity: LocalIdentity): void {
  root.replaceChildren(
    block("identity-card", [
      line(identity.handle, "identity-card__handle"),
      line(identity.bio),
      line(`fingerprint ${identity.fingerprintSnippet}`, "is-muted"),
    ]),
  );
}

// Notifications panel — lower-left of the shell. Renders five
// notification categories with state-aware action sets:
//   - follow                      → follow back / dismiss / block
//   - reaction_recommend (like)   → view / dismiss
//   - reaction_downrank (dislike) → view / dismiss
//   - reply                       → view / dismiss
//   - repost                      → view / dismiss
// Connect/friend is intentionally NOT a notification category — it
// lives in the lookup-card relationship UI. `clearAllButton` is
// shown only while the panel has visible rows; clicking it asks
// the coordinator to dismiss every visible row in one write.
// Dismissal is local-only (IndexedDB) on the recipient device.
export type NotificationActionKind = "follow-back" | "dismiss" | "block" | "view";

export type NotificationsViewModel = {
  notifications: SocialNotification[];
  ownConnections: Map<string, ConnectionRelationship["tier"]>;
  ownSubscriptions: Set<string>;
};

export function renderNotificationsPanel(
  list: HTMLElement,
  empty: HTMLElement,
  clearAllButton: HTMLButtonElement | null,
  view: NotificationsViewModel,
  onAction: (notification: SocialNotification, action: NotificationActionKind) => void
): void {
  // Phase 13.1: when the user has zero notifications, hide the
  // entire panel (heading + container) instead of leaving a dead
  // "no notifications" placeholder. The heading lives in a sibling
  // element addressable via the panel's parent; we toggle both
  // together so the layout stays clean.
  const panel = list.closest<HTMLElement>(".notifications");
  const heading = document.getElementById("notifications-title");
  if (view.notifications.length === 0) {
    list.replaceChildren();
    list.hidden = true;
    empty.hidden = true;
    if (panel !== null) panel.hidden = true;
    if (heading !== null) heading.hidden = true;
    if (clearAllButton !== null) clearAllButton.hidden = true;
    return;
  }

  if (heading !== null) heading.hidden = false;
  if (panel !== null) panel.hidden = false;
  empty.hidden = true;
  list.hidden = false;
  if (clearAllButton !== null) clearAllButton.hidden = false;

  const fragment = document.createDocumentFragment();
  for (const notification of view.notifications) {
    fragment.append(renderNotificationRow(notification, view.ownConnections, view.ownSubscriptions, onAction));
  }
  list.replaceChildren(fragment);
}

function renderNotificationRow(
  notification: SocialNotification,
  ownConnections: Map<string, ConnectionRelationship["tier"]>,
  ownSubscriptions: Set<string>,
  onAction: (notification: SocialNotification, action: NotificationActionKind) => void
): HTMLElement {
  const row = document.createElement("div");
  row.className = "notification-row";
  row.dataset["notificationId"] = notification.id;

  const actorHandle = notification.actor_handle ?? notification.actor_canonical_id;
  const lead = document.createElement("div");
  lead.className = "notification-row__line";
  lead.textContent = `${actorHandle} ${describeAction(notification.kind)}`;
  row.append(lead);

  const actions = document.createElement("div");
  actions.className = "notification-row__actions";

  if (notification.kind === "follow") {
    const actorTier = ownConnections.get(notification.actor_canonical_id);
    const reciprocallyFollowing = ownSubscriptions.has(notification.actor_canonical_id);
    const reciprocallyConnected = actorTier === "known" || actorTier === "close";

    const sub = document.createElement("div");
    sub.className = "notification-row__sub notification-row__line";
    sub.textContent = describeReciprocal(reciprocallyFollowing, reciprocallyConnected);
    row.append(sub);

    if (!reciprocallyFollowing && !reciprocallyConnected) {
      actions.append(notificationButton("follow back", () => onAction(notification, "follow-back")));
    }
    actions.append(notificationButton("dismiss", () => onAction(notification, "dismiss")));
    if (actorTier !== "blocked") {
      actions.append(notificationButton("block", () => onAction(notification, "block")));
    }
  } else {
    // Post-interaction: view opens the relevant post/thread; dismiss
    // hides the row locally. We only emit "view" when there's a
    // post to navigate to.
    if (typeof notification.post_id === "string" && notification.post_id.length > 0) {
      actions.append(notificationButton("view", () => onAction(notification, "view")));
    }
    actions.append(notificationButton("dismiss", () => onAction(notification, "dismiss")));
  }

  row.append(actions);
  return row;
}

function describeAction(kind: SocialNotification["kind"]): string {
  switch (kind) {
    case "follow": return "follows you";
    case "connection_confirmed": return "and you are now connected";
    case "reaction_recommend": return "liked your post";
    case "reaction_downrank": return "disliked your post";
    case "reply": return "replied to your post";
    case "repost": return "reposted your post";
  }
}

function notificationButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "notification-row__action";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function describeReciprocal(reciprocallyFollowing: boolean, reciprocallyConnected: boolean): string {
  if (reciprocallyFollowing) return "you follow them too";
  if (reciprocallyConnected) return "you are connected";
  return "follow back, dismiss, or block";
}

// Per-device sync health view-model. Mirrors src/web/client/sync/
// sync-health.ts → DeviceSyncHealth. Kept structural here so this
// module doesn't need a runtime dependency on the sync layer.
export type DevicePanelHealth = {
  status: "current" | "synced" | "syncing" | "retry_pending" | "failed" | "revoked" | "unknown";
  label: string;
  lastSeenLine: string;
  canRetry: boolean;
  advanced: {
    deviceIdShort: string;
    attempts?: number;
    lastAttemptAt?: string;
    lastError?: string;
    totalEvents?: number;
    sliceProgress?: { [slice: string]: number };
    recipientCursor?: number;
    originSequence?: number;
    attemptHistory?: Array<{ at: string; ok: boolean; error?: string; total_events?: number }>;
    ourLastOriginSequence?: number;
    peerRecipientCursor?: number;
    inboundBehindBy?: number;
    peerProgressFreshAt?: number;
  };
};

export type DevicePanelRow = {
  device: TrustedDevice;
  health: DevicePanelHealth;
};

export function renderDevicePanel(
  root: HTMLElement,
  currentDeviceId: string | null,
  rows: DevicePanelRow[],
  _pairingCode: string | null
): void {
  // The dialog now organizes devices into three sections:
  //   1. this device         — the current browser; no destructive action
  //   2. linked devices      — other active peers; each has a revoke
  //                            button and an advanced disclosure
  //   3. revoked devices     — collapsed by default; rows offer
  //                            "link again" to re-pair as a fresh
  //                            device row (revoked record stays put)
  //
  // The temporary-passcode card is NOT rendered here — it lives in
  // index.html (`<section id="pairing-card" hidden>`) and is shown
  // only when the user clicks "link another device". The previous
  // implementation prepended a debug-y "pairing code: X" line which
  // duplicated that card; that line is gone.
  const fragment = document.createDocumentFragment();

  const currentRows = rows.filter((r) => r.device.device_id === currentDeviceId);
  const peerRows = rows.filter((r) => r.device.device_id !== currentDeviceId && r.device.trust_state !== "revoked");
  const revokedRows = rows.filter((r) => r.device.device_id !== currentDeviceId && r.device.trust_state === "revoked");

  // Section 1: this device.
  const thisSection = document.createElement("section");
  thisSection.className = "devices-panel__section devices-panel__section--current";
  const thisHeader = document.createElement("h3");
  thisHeader.className = "devices-panel__section-title is-muted";
  thisHeader.textContent = "this device";
  thisSection.append(thisHeader);
  if (currentRows.length === 0) {
    thisSection.append(line("not signed in", "is-muted"));
  } else {
    for (const r of currentRows) thisSection.append(renderDeviceRow(r, currentDeviceId));
  }
  fragment.append(thisSection);

  // Section 2: other active linked devices.
  const peersSection = document.createElement("section");
  peersSection.className = "devices-panel__section devices-panel__section--peers";
  const peersHeader = document.createElement("h3");
  peersHeader.className = "devices-panel__section-title is-muted";
  peersHeader.textContent = "linked devices";
  peersSection.append(peersHeader);
  if (peerRows.length === 0) {
    peersSection.append(line("no other devices linked yet", "is-muted"));
  } else {
    for (const r of peerRows) peersSection.append(renderDeviceRow(r, currentDeviceId));
  }
  fragment.append(peersSection);

  // Section 3: revoked devices, collapsed by default. Rendered only
  // when there's something to show so the dialog doesn't carry an
  // empty header for the common "never revoked anyone" case.
  if (revokedRows.length > 0) {
    const revokedSection = document.createElement("section");
    revokedSection.className = "devices-panel__section devices-panel__section--revoked";
    const details = document.createElement("details");
    details.className = "devices-panel__revoked-details";
    const summary = document.createElement("summary");
    summary.className = "devices-panel__section-title is-muted";
    summary.textContent = `revoked devices (${revokedRows.length})`;
    details.append(summary);
    for (const r of revokedRows) details.append(renderDeviceRow(r, currentDeviceId));
    revokedSection.append(details);
    fragment.append(revokedSection);
  }

  root.replaceChildren(fragment);
}

function renderDeviceRow(
  { device, health }: DevicePanelRow,
  currentDeviceId: string | null
): HTMLElement {
  const row = block("device-row", [
    line(`${device.name}${device.device_id === currentDeviceId ? " (current)" : ""}`, "device-row__name")
  ]);
  row.dataset["deviceId"] = device.device_id;
  row.classList.add(`device-row--${health.status}`);

  const statusLine = document.createElement("div");
  statusLine.className = `device-row__status device-row__status--${health.status} is-muted`;
  statusLine.dataset["deviceStatus"] = health.status;
  statusLine.textContent = health.label;
  row.append(statusLine);

  if (health.lastSeenLine.length > 0) {
    row.append(line(health.lastSeenLine, "is-muted"));
  }

  // Action area appears BEFORE the advanced disclosure so destructive
  // actions are immediately visible — previously the revoke button
  // was below a long advanced section and felt buried.
  const actions = document.createElement("div");
  actions.className = "device-row__actions";
  const isCurrent = device.device_id === currentDeviceId;
  if (health.canRetry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "lookup-card__button device-row__retry";
    retry.dataset["deviceAction"] = "retry-sync";
    retry.dataset["deviceId"] = device.device_id;
    retry.textContent = "retry sync";
    actions.append(retry);
  }
  if (device.trust_state === "revoked" && !isCurrent) {
    const linkAgain = document.createElement("button");
    linkAgain.type = "button";
    linkAgain.className = "lookup-card__button device-row__link-again";
    linkAgain.dataset["deviceAction"] = "link-again";
    linkAgain.dataset["deviceId"] = device.device_id;
    linkAgain.textContent = "link again";
    actions.append(linkAgain);
    const help = document.createElement("div");
    help.className = "device-row__help is-muted";
    help.textContent = "link this device again to restore access";
    actions.append(help);
  } else if (!isCurrent) {
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "lookup-card__button device-row__revoke";
    revoke.dataset["deviceAction"] = "revoke-prompt";
    revoke.dataset["deviceId"] = device.device_id;
    revoke.textContent = "revoke";
    actions.append(revoke);

    const confirmPane = document.createElement("div");
    confirmPane.className = "device-row__confirm";
    confirmPane.hidden = true;
    confirmPane.dataset["deviceConfirm"] = device.device_id;
    const confirmTitle = document.createElement("div");
    confirmTitle.className = "device-row__confirm-title";
    confirmTitle.textContent = `revoke ${device.name}?`;
    const confirmBody = document.createElement("div");
    confirmBody.className = "device-row__confirm-body is-muted";
    // Phase 10.2: be explicit about what revoke does and doesn't do.
    // The user needs to know that revoking one device doesn't sign
    // them out of the others, and that the account on sudo isn't
    // deleted — just this device's access.
    confirmBody.textContent = "that device can't send or read messages anymore. your other linked devices stay signed in, and your account on sudo isn't touched. the revoked device would need to link again to come back.";
    const confirmActions = document.createElement("div");
    confirmActions.className = "device-row__confirm-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "lookup-card__button device-row__confirm-cancel";
    cancelBtn.dataset["deviceAction"] = "revoke-cancel";
    cancelBtn.dataset["deviceId"] = device.device_id;
    cancelBtn.textContent = "cancel";
    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "lookup-card__button device-row__confirm-go";
    confirmBtn.dataset["deviceAction"] = "revoke-confirm";
    confirmBtn.dataset["deviceId"] = device.device_id;
    confirmBtn.textContent = "revoke device";
    confirmActions.append(cancelBtn, confirmBtn);
    confirmPane.append(confirmTitle, confirmBody, confirmActions);
    actions.append(confirmPane);
  }
  row.append(actions);

  // Advanced disclosure. Hidden by default; the only place where
  // ids, attempt counts, cursors, and raw error strings appear.
  const details = document.createElement("details");
  details.className = "device-row__advanced";
  const summary = document.createElement("summary");
  summary.textContent = "advanced";
  summary.className = "device-row__advanced-summary is-muted";
  details.append(summary);
  const advancedBody = document.createElement("div");
  advancedBody.className = "device-row__advanced-body";
  advancedBody.append(line(`id: ${health.advanced.deviceIdShort}`, "is-muted"));
  if (typeof health.advanced.attempts === "number") {
    advancedBody.append(line(`backfill attempts: ${health.advanced.attempts}`, "is-muted"));
  }
  if (typeof health.advanced.totalEvents === "number") {
    advancedBody.append(line(`events sent: ${health.advanced.totalEvents}`, "is-muted"));
  }
  if (typeof health.advanced.recipientCursor === "number") {
    advancedBody.append(line(`incoming cursor: ${health.advanced.recipientCursor}`, "is-muted"));
  }
  if (typeof health.advanced.originSequence === "number") {
    advancedBody.append(line(`outgoing sequence: ${health.advanced.originSequence}`, "is-muted"));
  }
  if (typeof health.advanced.lastAttemptAt === "string") {
    advancedBody.append(line(`last attempt: ${health.advanced.lastAttemptAt}`, "is-muted"));
  }
  if (typeof health.advanced.lastError === "string" && health.advanced.lastError.length > 0) {
    advancedBody.append(line(`last error: ${health.advanced.lastError}`, "is-muted"));
  }
  if (typeof health.advanced.ourLastOriginSequence === "number") {
    advancedBody.append(line(`our outgoing sequence: ${health.advanced.ourLastOriginSequence}`, "is-muted"));
  }
  if (typeof health.advanced.peerRecipientCursor === "number") {
    advancedBody.append(line(`peer applied cursor: ${health.advanced.peerRecipientCursor}`, "is-muted"));
  }
  if (typeof health.advanced.inboundBehindBy === "number") {
    advancedBody.append(line(`inbound behind: ${health.advanced.inboundBehindBy}`, "is-muted"));
  }
  if (typeof health.advanced.peerProgressFreshAt === "number") {
    advancedBody.append(line(`progress refreshed: ${formatHistoryTime(new Date(health.advanced.peerProgressFreshAt).toISOString())}`, "is-muted"));
  }
  if (Array.isArray(health.advanced.attemptHistory) && health.advanced.attemptHistory.length > 0) {
    advancedBody.append(line("recent attempts:", "is-muted"));
    const historyList = document.createElement("ul");
    historyList.className = "device-row__history is-muted";
    for (const entry of [...health.advanced.attemptHistory].reverse()) {
      const item = document.createElement("li");
      const time = formatHistoryTime(entry.at);
      const outcome = entry.ok
        ? (typeof entry.total_events === "number" ? `ok, ${entry.total_events} events` : "ok")
        : (typeof entry.error === "string" && entry.error.length > 0 ? `failed, ${entry.error}` : "failed");
      item.textContent = `${time} ${outcome}`;
      historyList.append(item);
    }
    advancedBody.append(historyList);
  }
  details.append(advancedBody);
  row.append(details);

  return row;
}

export function renderSignupState(root: HTMLElement, state: SignupState): void {
  if (state.status === "idle") {
    root.replaceChildren(
      line("development account flow only", "is-muted"),
    );
    return;
  }

  if (state.status === "loading") {
    root.replaceChildren(line("creating account...", "is-muted"));
    return;
  }

  if (state.status === "waiting_for_local_data") {
    root.replaceChildren(...renderWaitingForLocalData());
    return;
  }

  if (state.status === "error") {
    root.replaceChildren(line(state.message, "is-danger"));
    return;
  }

  root.replaceChildren(
    block("signup-result", [
      line(`created ${state.identity.handle}`),
      // Post-signup nudge. Recovery is the user's responsibility now —
      // the server holds nothing that could authenticate them. Both
      // paths (encrypted backup file and a paired second device) are
      // mentioned so the user understands they have options. The
      // account menu surfaces "backup account" and "linked devices".
      line("your account keys live on this device.", "signup-result__label"),
      line("export an encrypted backup or pair another device so you don't lose access — open the account menu (top right) when you're ready.", "is-muted"),
      line(`fingerprint: ${state.fingerprint.slice(0, 12)}...`, "is-muted"),
    ]),
  );
}

export function renderSigninState(root: HTMLElement, state: SigninState): void {
  if (state.status === "idle") {
    root.replaceChildren(line("use your handle and passphrase", "is-muted"));
    return;
  }

  if (state.status === "loading") {
    root.replaceChildren(line("signing in...", "is-muted"));
    return;
  }

  if (state.status === "waiting_for_local_data") {
    root.replaceChildren(...renderWaitingForLocalData());
    return;
  }

  if (state.status === "error") {
    root.replaceChildren(line(state.message, "is-danger"));
    return;
  }

  root.replaceChildren(line(`signed in as ${state.identity.handle}`, "signup-result__label"));
}

function renderWaitingForLocalData(): HTMLElement[] {
  // Calm, non-destructive copy. Local-first state is durable, multi-tab
  // usage is normal, and we don't blame other tabs for transient open
  // delays.
  return [
    line("opening local data...", "is-muted"),
    line("retrying automatically.", "is-muted")
  ];
}

export function renderStream(root: HTMLElement, items: UnifiedFeedItem[] = []): void {
  unmountAllTextSurfaces();
  if (items.length === 0) {
    root.replaceChildren(line("no posts yet", "lookup__empty"));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.append(renderUnifiedFeedItem(item));
  root.replaceChildren(fragment);
}

export function renderDiscoveryPanel(
  root: HTMLElement,
  state: DiscoveryState,
  viewerCanonicalId?: string
): void {
  // Discover is presented as a feed, not a debug ranking index. Mode
  // toggles, score numbers, and reaction count strings have moved off
  // the user-facing surface — the UI uses the same post card as the
  // personal feed.
  if (state.status === "idle" || state.status === "loading") {
    root.replaceChildren(line("loading...", "lookup__empty"));
    return;
  }

  if (state.status === "error") {
    root.replaceChildren(line(state.message, "is-danger"));
    return;
  }

  if (state.posts.length === 0) {
    root.replaceChildren(line("no discoverable posts", "lookup__empty"));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const post of state.posts) {
    fragment.append(renderUnifiedFeedItem(discoveryToUnifiedItem(post, viewerCanonicalId)));
  }
  root.replaceChildren(fragment);
}

export function feedPostToUnifiedItem(
  post: FeedPost,
  enrichment: {
    counts?: ReactionCounts;
    vote?: VoteKind;
    viewerHasReposted?: boolean;
    viewerCanonicalId?: string;
  } = {}
): UnifiedFeedItem {
  const text = post.body
    ?? post.public_metadata?.summary
    ?? post.public_metadata?.title
    ?? "[encrypted body]";
  // Normalize "is this post mine?" check across plain posts and reposts.
  // For a repost, the relevant author is the embedded original's author
  // (the server hydrates repost_of_post for personal/thread responses).
  // For a plain post, it's the post's author.
  const normalizedAuthor = post.kind === "repost" && post.repost_of_post != null
    ? post.repost_of_post.author_canonical_id
    : post.author_canonical_id;
  const viewerIsAuthor = enrichment.viewerCanonicalId !== undefined
    && enrichment.viewerCanonicalId.length > 0
    && enrichment.viewerCanonicalId === normalizedAuthor;
  return {
    post_id: post.post_id,
    author_canonical_id: post.author_canonical_id,
    author_handle: post.author_handle,
    body: text,
    created_at: post.created_at,
    counts: enrichment.counts ?? { ...ZERO_COUNTS },
    vote: enrichment.vote ?? null,
    kind: post.kind ?? "post",
    repost_of: post.repost_of === undefined ? undefined
      : embeddedFromMaybe(post.repost_of_post),
    reply_to: post.reply_to === undefined ? undefined
      : embeddedFromMaybe(post.reply_to_post),
    viewer_has_reposted: enrichment.viewerHasReposted ?? false,
    viewer_is_author: viewerIsAuthor
  };
}

function embeddedFromMaybe(post: FeedPost | null | undefined): EmbeddedFeedItem {
  if (post === null || post === undefined) return { unavailable: true };
  const body = post.body
    ?? post.public_metadata?.summary
    ?? post.public_metadata?.title
    ?? "[encrypted body]";
  // Recursively materialize a nested embedded repost so the card can
  // render up to 2 visible levels (handled by the renderer's depth
  // bound). embeddedFromMaybe runs once per server-decorated layer; the
  // server hydrates `repost_of_post` two levels deep, so deeper chains
  // resolve to "view original post" at render time.
  const nested = post.repost_of_post === undefined
    ? undefined
    : embeddedFromMaybe(post.repost_of_post);
  return {
    post_id: post.post_id,
    author_canonical_id: post.author_canonical_id,
    author_handle: post.author_handle,
    body,
    created_at: post.created_at,
    ...(nested === undefined ? {} : { embedded_repost: nested })
  };
}

function discoveryToUnifiedItem(post: DiscoveryPostIndex, viewerCanonicalId?: string): UnifiedFeedItem {
  const body = post.body_excerpt && post.body_excerpt.length > 0
    ? post.body_excerpt
    : "[no excerpt]";
  return {
    post_id: post.post_id,
    author_canonical_id: post.author_canonical_id,
    author_handle: post.author_handle,
    body,
    created_at: post.created_at,
    counts: {
      recommend: post.recommend_count ?? 0,
      downrank: post.downrank_count ?? 0,
      reply: post.reply_count ?? 0,
      repost: post.repost_count ?? 0
    },
    vote: post.viewer_reaction === "recommend" ? "like"
      : post.viewer_reaction === "downrank" ? "dislike"
      : null,
    kind: "post",
    viewer_has_reposted: post.viewer_has_reposted ?? false,
    // Discovery doesn't hydrate repost_of_post, so this is a
    // best-effort literal-author check. For the typical case (your
    // own post in discover) the literal author IS the normalized
    // author. The server enforces the rule for the corner cases.
    viewer_is_author: viewerCanonicalId !== undefined
      && viewerCanonicalId.length > 0
      && viewerCanonicalId === post.author_canonical_id
  };
}

function renderUnifiedFeedItem(item: UnifiedFeedItem): HTMLElement {
  const article = document.createElement("article");
  article.className = `stream-post stream-post--${item.kind ?? "post"}`;
  article.dataset["postId"] = item.post_id;
  if (item.kind !== undefined) article.dataset["postKind"] = item.kind;

  // The meta + body region is the post's "main" surface. Clicking
  // anywhere inside it should open the focused thread view; clicking
  // an action button or anything inside the replies panel should not.
  const main = document.createElement("div");
  main.className = "stream-post__main";
  main.dataset["threadOpen"] = "true";

  const meta = document.createElement("div");
  meta.className = "stream-post__meta";

  const author = document.createElement("span");
  author.className = "stream-post__handle";
  // Top-level cards never carry a "replied" suffix anymore: replies
  // are nested-only and never surface as standalone cards. Reposts
  // still get an inline "reposted" tag because the card itself
  // wraps an embedded original.
  const authorLabel = item.author_handle ?? shortCanonical(item.author_canonical_id);
  author.textContent = item.kind === "repost" ? `${authorLabel} reposted` : authorLabel;

  const time = document.createElement("span");
  time.className = "stream-post__time";
  time.textContent = formatPostTimestamp(item.created_at);

  meta.append(author, time);
  main.append(meta);

  if (item.kind !== "repost" || item.body.length > 0 && item.body !== "[encrypted body]") {
    const body = document.createElement("div");
    body.className = "stream-post__body";
    mountTextSurface(body, item.body, { font: BODY_FONT, lineHeight: 23 });
    main.append(body);
  }

  article.append(main);

  // Repost: show the embedded original card outside the main click
  // surface so clicking the embed doesn't open the wrong thread.
  if (item.kind === "repost" && item.repost_of !== undefined) {
    article.append(renderEmbeddedPost(item.repost_of, 1));
  }

  const actions = document.createElement("div");
  actions.className = "stream-post__actions";
  actions.append(renderVoteButton(item.counts, item.vote));
  actions.append(renderActionButton("reply", "↩", item.counts.reply));
  // Self-repost is blocked end-to-end; the button only renders when
  // the viewer didn't author the normalized original. The backend
  // also rejects with cannot_repost_own_post if forced.
  if (item.viewer_is_author !== true) {
    actions.append(renderActionButton("repost", "↻", item.counts.repost, item.viewer_has_reposted === true));
  }
  // Phase 13.1: delete affordance for the viewer's own posts.
  // Two-step: first click sets data-delete-pending="1" on the
  // article; second click within ~3s actually fires the DELETE
  // request. Click-out / blur resets the pending state. Main.ts
  // handles the actual fetch + local row removal via its
  // delegated click listener on the feed root.
  if (item.viewer_is_author === true) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "stream-post__action stream-post__action--delete";
    deleteBtn.dataset["action"] = "delete";
    deleteBtn.textContent = "delete";
    deleteBtn.title = "delete post";
    deleteBtn.setAttribute("aria-label", "delete this post");
    actions.append(deleteBtn);
  }
  article.append(actions);

  // Comments live inside this panel and stay hidden until the user
  // clicks ↩ (or opens the post in thread view). The renderer no
  // longer auto-loads them — feeds stay clean by default.
  const repliesPanel = document.createElement("div");
  repliesPanel.className = "stream-post__replies";
  repliesPanel.dataset["repliesPanel"] = item.post_id;
  repliesPanel.hidden = true;
  article.append(repliesPanel);

  return article;
}

// Maximum visible embedded levels inside a single feed card. A repost
// of a repost renders the outer wrapper + 2 embedded levels; deeper
// chains collapse to a "view original post" link that navigates to the
// canonical original.
const MAX_EMBED_DEPTH = 2;

function renderEmbeddedPost(ref: EmbeddedFeedItem, depth: number): HTMLElement {
  const card = document.createElement("blockquote");
  card.className = "stream-post__embed";
  if (ref.unavailable === true) {
    card.textContent = "original post unavailable";
    return card;
  }
  // The embed is itself a clickable surface that opens the original
  // post's thread. The outer feed card's main click handler ignores
  // clicks inside the embed (see handleFeedClick in main.ts).
  card.dataset["threadOpenEmbed"] = "true";
  card.dataset["embedPostId"] = ref.post_id;
  card.setAttribute("role", "link");
  card.tabIndex = 0;

  const meta = document.createElement("div");
  meta.className = "stream-post__embed-meta";
  const handle = document.createElement("span");
  handle.className = "stream-post__embed-handle";
  handle.textContent = ref.author_handle ?? shortCanonical(ref.author_canonical_id);
  const time = document.createElement("span");
  time.className = "stream-post__embed-time";
  time.textContent = formatPostTimestamp(ref.created_at);
  meta.append(handle, time);

  const body = document.createElement("div");
  body.className = "stream-post__embed-body";
  body.textContent = ref.body;
  card.append(meta, body);

  if (ref.embedded_repost !== undefined) {
    if (depth + 1 > MAX_EMBED_DEPTH) {
      // Beyond the visible nesting limit — the outer chain is already
      // 2 levels deep. Drop a navigation hint that opens the canonical
      // original directly (the embed's click handler still uses
      // ref.post_id, so this is a visual signal, not a separate
      // target).
      const more = document.createElement("div");
      more.className = "stream-post__embed-more";
      more.textContent = "view original post";
      card.append(more);
    } else {
      card.append(renderEmbeddedPost(ref.embedded_repost, depth + 1));
    }
  }
  return card;
}

function renderVoteButton(counts: ReactionCounts, vote: VoteKind): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  const state = vote === "like" ? "liked" : vote === "dislike" ? "disliked" : "neutral";
  button.className = `stream-post__action stream-post__action--vote stream-post__action--vote-${state}`;
  button.dataset["voteState"] = state;
  // Net score is the user-facing number; the popover/cycle is what
  // changes the user's own vote, but the count reflects the post's
  // overall sentiment.
  const net = (counts.recommend ?? 0) - (counts.downrank ?? 0);
  const glyph = document.createElement("span");
  glyph.className = "stream-post__action-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = vote === "like" ? "△" : vote === "dislike" ? "▽" : "◇";

  const counter = document.createElement("span");
  counter.className = "stream-post__action-count";
  counter.textContent = String(net);

  button.setAttribute("aria-label",
    vote === "like" ? "you voted up; click to change vote"
      : vote === "dislike" ? "you voted down; click to change vote"
      : "vote on this post");
  button.append(glyph, counter);
  return button;
}

function renderActionButton(
  kind: "reply" | "repost",
  glyphChar: string,
  count: number,
  alreadyReposted = false
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  const alreadyClass = kind === "repost" && alreadyReposted ? " is-already" : "";
  button.className = `stream-post__action stream-post__action--${kind}${alreadyClass}`;
  button.dataset["reaction"] = kind;
  if (kind === "repost" && alreadyReposted) {
    button.dataset["alreadyReposted"] = "true";
    button.setAttribute("aria-label", "you have already reposted this");
    button.title = "you have already reposted this";
  } else {
    button.setAttribute("aria-label", kind);
  }

  const glyph = document.createElement("span");
  glyph.className = "stream-post__action-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = glyphChar;

  const counter = document.createElement("span");
  counter.className = "stream-post__action-count";
  counter.textContent = String(count);

  button.append(glyph, counter);
  return button;
}

export function renderLookupResult(root: HTMLElement, state: LookupState): void {
  if (state.status === "idle") {
    // Helper text now lives statically below the search input as
    // `#directory-hint`; the result panel stays empty until the user types.
    root.replaceChildren();
    return;
  }

  if (state.status === "loading") {
    root.replaceChildren(line(`resolving @${state.query}...`, "lookup__empty"));
    return;
  }

  if (state.status === "error") {
    root.replaceChildren(
      block("lookup-card lookup-card--error", [
        line(`@${state.query}`),
        line(state.message, "is-danger"),
      ]),
    );
    return;
  }

  root.replaceChildren(renderResolvedIdentity(state.identity, state.fingerprint, state.relationship, state.subscription));
}

export function renderChatList(root: HTMLElement, localChats: ChatSummary[] = []): void {
  if (localChats.length === 0) {
    // Phase 13: pristine empty state. Two short lines, no exclamation,
    // no "you have 0 chats" awkwardness — just a calm placeholder
    // and a hint of what to do next.
    const wrap = document.createElement("div");
    wrap.className = "chat-list__empty";
    const title = document.createElement("div");
    title.className = "chat-list__empty-title";
    title.textContent = "your conversations will appear here";
    const hint = document.createElement("div");
    hint.className = "chat-list__empty-hint";
    hint.textContent = "share your handle to start talking.";
    wrap.append(title, hint);
    root.replaceChildren(wrap);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const chat of localChats) {
    fragment.append(renderChat(chat));
  }
  root.replaceChildren(fragment);
}

export function renderSearchResults(
  root: HTMLElement,
  state: SearchState,
  followedCanonicals: Set<string>,
  pendingFollowCanonicals: Set<string>,
  onToggle: (result: SearchResult) => void
): void {
  if (state.status === "idle") {
    root.replaceChildren();
    return;
  }

  if (state.status === "loading") {
    root.replaceChildren(line("searching...", "lookup__empty"));
    return;
  }

  if (state.status === "error") {
    root.replaceChildren(line(state.message, "is-danger"));
    return;
  }

  if (state.results.length === 0) {
    root.replaceChildren(line("no identity found", "lookup__empty"));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const result of state.results) {
    const isFollowed = followedCanonicals.has(result.canonical);
    const isPending = pendingFollowCanonicals.has(result.canonical);
    const children: HTMLElement[] = [line(result.handle, "search-result__handle")];
    if (typeof result.bio === "string" && result.bio.length > 0) {
      children.push(line(result.bio, "is-muted"));
    }
    const row = block("search-result", children);
    if (result.fingerprint_grid !== undefined) {
      row.prepend(renderFingerprintGrid(result.fingerprint_grid));
    }
    const button = document.createElement("button");
    button.className = "search-result__add";
    button.type = "button";
    button.textContent = isPending ? "following…" : isFollowed ? "following" : "follow";
    button.disabled = isPending;
    // Compact-mode CSS swaps the label for a glyph; preserve the
    // full label on title/aria-label, and flag the "already
    // following" state so the glyph can switch to a tick instead of
    // a plus.
    button.title = button.textContent;
    button.setAttribute("aria-label", button.textContent);
    if (isFollowed) button.dataset["following"] = "true";
    button.addEventListener("click", () => onToggle(result));
    row.append(button);
    fragment.append(row);
  }

  root.replaceChildren(fragment);
}



// Pretty-print the connection tier for the lookup card. Defaults to
// "no" (rather than the protocol-level "unknown" tier) so the user
// sees "no connection" instead of jargon.
function describeConnection(relationship?: ConnectionRelationship): string {
  if (relationship === undefined || relationship === null) return "no";
  if (relationship.tier === "known") return "connected";
  if (relationship.tier === "close") return "close friend";
  if (relationship.tier === "blocked") return "blocked";
  return "no";
}

function renderResolvedIdentity(
  identity: IdentityDocument,
  fingerprint: string,
  relationship?: ConnectionRelationship,
  subscription?: FeedSubscription | null
): HTMLElement {
  const isFollowing = subscription !== null && subscription !== undefined && subscription.muted !== true;
  const tier = relationship?.tier ?? "unknown";
  const card = block("lookup-card", [
    line(identity.handle, "lookup-card__handle"),
    // Short relationship status only. Canonical id, raw fingerprint,
    // trust state, onion availability, and updated timestamp are
    // hidden behind the advanced disclosure below.
    line(
      isFollowing
        ? tier === "known" || tier === "close"
          ? "you follow each other — chat unlocked"
          : "following — chats unlock when they follow you back"
        : tier === "blocked"
          ? "blocked"
          : "not following yet",
      "is-muted"
    )
  ]);

  // Default action row is intentionally minimal: follow/unfollow on
  // one axis, block/unblock on the other. Tier controls (known /
  // close-friend / disconnect) live in the advanced disclosure
  // because they are local trust labels — they no longer affect
  // chat eligibility, which is gated on mutual follow only.
  const actions = document.createElement("div");
  actions.className = "lookup-card__actions";

  if (tier === "blocked") {
    actions.append(button("unblock", "set-unblock"));
  } else {
    if (isFollowing) actions.append(button("unfollow", "set-unsubscribe"));
    else actions.append(button("follow", "set-subscribe"));
    actions.append(button("block", "set-block"));
  }

  card.append(actions);

  card.append(renderAdvancedIdentityDetails(identity, fingerprint, tier));

  if (identity.visual_fingerprint !== undefined) {
    card.prepend(renderFingerprintGrid(identity.visual_fingerprint));
  }

  return card;
}

function renderAdvancedIdentityDetails(
  identity: IdentityDocument,
  fingerprint: string,
  tier: "unknown" | "known" | "close" | "blocked"
): HTMLElement {
  const details = document.createElement("details");
  details.className = "lookup-card__advanced";
  const summary = document.createElement("summary");
  summary.className = "lookup-card__advanced-summary";
  summary.textContent = "advanced identity details";
  details.append(summary);

  const fields = block("lookup-card__advanced-fields", [
    line(`canonical: ${shortCanonical(identity.canonical_id)}`, "is-muted"),
    line(`fingerprint: ${identity.visual_fingerprint?.fingerprint ?? `${fingerprint.slice(0, 12)}...`}`, "is-muted"),
    line("trust: unverified", "is-muted"),
    line("onion: unknown", "is-muted"),
    line(`updated: ${formatTimestamp(identity.updated_at)}`, "is-muted")
  ]);
  details.append(fields);

  // Local trust state (debug). Does NOT unlock chat — chat is gated
  // on mutual follow detected by the server. Kept here so power
  // users / smokes can still inspect or set the local relationship
  // tier without exposing it in the default card.
  const trustNote = line(
    "local trust state — does not affect chat eligibility",
    "is-muted"
  );
  trustNote.classList.add("lookup-card__advanced-note");
  details.append(trustNote);

  const trustActions = document.createElement("div");
  trustActions.className = "lookup-card__advanced-actions";

  if (tier !== "blocked") {
    if (tier === "known" || tier === "close") {
      trustActions.append(button("remove", "set-unknown"));
      if (tier === "close") trustActions.append(button("remove close", "set-known"));
      else trustActions.append(button("close friend", "set-close"));
    } else {
      trustActions.append(button("mark known", "set-known"));
    }
  }

  details.append(trustActions);

  return details;
}

function renderChat(chat: ChatSummary): HTMLElement {
  const row = document.createElement("div");
  row.className = "chat-row";
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const canonical = chat.canonical ?? chat.id;
  row.dataset["chatCanonical"] = canonical;
  row.dataset["chatHandle"] = chat.handle;
  if (chat.fingerprint !== undefined) row.dataset["chatFingerprint"] = chat.fingerprint;
  const unread = typeof chat.unreadCount === "number" && chat.unreadCount > 0 ? chat.unreadCount : 0;
  if (unread > 0) row.classList.add("chat-row--unread");

  const handle = document.createElement("div");
  handle.className = "chat-row__handle";
  handle.textContent = chat.handle;
  row.append(handle);

  // Phase 11.6: removed the numeric blue circle badge. Unread state
  // is conveyed by the bolder handle (.chat-row--unread .chat-row__handle)
  // alone. Per-conversation unread counts belong in the notifications
  // channel, not as inline pills on every chat row. We keep the
  // sr-only aria-label so screen readers still surface the count.
  if (unread > 0) {
    const srOnly = document.createElement("span");
    srOnly.className = "sr-only";
    srOnly.textContent = `${unread} unread message${unread === 1 ? "" : "s"}`;
    row.append(srOnly);
  }

  if (chat.lastLine && chat.lastLine.length > 0) {
    const preview = document.createElement("div");
    preview.className = "chat-row__preview";
    preview.textContent = chat.lastLine;
    row.append(preview);
  }

  return row;
}

export function renderFingerprintGrid(fingerprint: IdentityFingerprint): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "identity-fingerprint-grid";
  grid.setAttribute("aria-label", `identity fingerprint ${fingerprint.fingerprint}`);

  for (const cell of fingerprint.cells) {
    const element = document.createElement("span");
    element.className = cell.on ? "identity-fingerprint-grid__cell is-on" : "identity-fingerprint-grid__cell";
    element.style.backgroundColor = cell.color;
    grid.append(element);
  }

  return grid;
}

function block(className: string, children: HTMLElement[]): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.append(...children);
  return element;
}

function line(text: string, className?: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className === undefined ? "line" : `line ${className}`;
  element.textContent = text;
  return element;
}

function button(label: string, action: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "lookup-card__button";
  element.dataset["relationshipAction"] = action;
  // Carry the full label on title + aria-label so the compact-symbol
  // CSS (used at narrow widths to swap "follow"/"unfollow" for
  // "+"/"×") still announces the action to screen readers and
  // surfaces it on hover.
  element.title = label;
  element.setAttribute("aria-label", label);
  // The full label lives in a wrapper span so the compact-mode CSS
  // can hide it while a pseudo-element supplies the symbolic glyph.
  const inner = document.createElement("span");
  inner.className = "lookup-card__button-text";
  inner.textContent = label;
  element.append(inner);
  return element;
}


function rule(): HTMLElement {
  const element = document.createElement("div");
  element.className = "rule";
  element.setAttribute("aria-hidden", "true");
  return element;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

export function formatPostTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const datePart = `${pad2(date.getDate())} ${months[date.getMonth()]}`;
  // Only show the YY suffix when the post is from a different calendar year.
  if (date.getFullYear() !== now.getFullYear()) {
    return `${time} ${datePart} ${String(date.getFullYear()).slice(-2)}`;
  }
  return `${time} ${datePart}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function shortCanonical(value: string): string {
  if (value.length <= 24) return value;
  return `${value.slice(0, 18)}...${value.slice(-6)}`;
}

function formatHistoryTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return iso;
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

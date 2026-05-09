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
} from "./types.js";

// Unified feed item used by both the personal stream and the discover
// stream. Either source produces this shape and the same renderer
// draws it, so the two tabs feel like one feed with different sources.
export type ReactionKind = "recommend" | "downrank" | "reply" | "repost";
export type ReactionCounts = {
  recommend: number;
  downrank: number;
  reply: number;
  repost: number;
};
export type UnifiedFeedItem = {
  post_id: string;
  author_canonical_id: string;
  author_handle?: string;
  body: string;
  created_at: string;
  counts: ReactionCounts;
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

export function renderDevicePanel(
  root: HTMLElement,
  currentDeviceId: string | null,
  devices: TrustedDevice[],
  pairingCode: string | null
): void {
  const fragment = document.createDocumentFragment();

  if (pairingCode !== null) {
    fragment.append(line(`pairing code: ${pairingCode}`, "is-muted"));
  }

  if (devices.length === 0) {
    fragment.append(line("no linked devices yet", "lookup__empty"));
    root.replaceChildren(fragment);
    return;
  }

  for (const device of devices) {
    const row = block("device-row", [
      line(`${device.name}${device.device_id === currentDeviceId ? " (current)" : ""}`, "device-row__name"),
      line(`status: ${device.trust_state}`, "is-muted"),
      line(`last seen: ${device.last_seen_at}`, "is-muted"),
      line(`sync: ${device.capabilities.can_sync ? "yes" : "no"}  decrypt: ${device.capabilities.can_decrypt ? "yes" : "no"}`, "is-muted"),
      line(`id: ${shortCanonical(device.device_id)}`, "is-muted"),
    ]);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lookup-card__button";
    button.dataset["deviceAction"] = "revoke";
    button.dataset["deviceId"] = device.device_id;
    button.textContent = device.trust_state === "revoked" ? "revoked" : "revoke";
    button.disabled = device.trust_state === "revoked";
    row.append(button);
    fragment.append(row);
  }

  root.replaceChildren(fragment);
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
      ...(state.backupCode.length === 0
        ? [line("save your recovery information in the panel below.", "is-muted")]
        : [
            line("account recovery code:", "signup-result__label"),
            line(state.backupCode, "signup-result__secret"),
            line("shown once. store it somewhere safe. the server only keeps a hash.", "is-muted")
          ]),
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

export function renderDiscoveryPanel(root: HTMLElement, state: DiscoveryState): void {
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
  for (const post of state.posts) fragment.append(renderUnifiedFeedItem(discoveryToUnifiedItem(post)));
  root.replaceChildren(fragment);
}

export function feedPostToUnifiedItem(post: FeedPost): UnifiedFeedItem {
  const text = post.body
    ?? post.public_metadata?.summary
    ?? post.public_metadata?.title
    ?? "[encrypted body]";
  return {
    post_id: post.post_id,
    author_canonical_id: post.author_canonical_id,
    author_handle: post.author_handle,
    body: text,
    created_at: post.created_at,
    // Personal feed posts don't carry reaction counts in their backend
    // shape; render zeros so the action row stays visually consistent.
    counts: { ...ZERO_COUNTS }
  };
}

function discoveryToUnifiedItem(post: DiscoveryPostIndex): UnifiedFeedItem {
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
    }
  };
}

const REACTION_GLYPHS: Record<ReactionKind, string> = {
  recommend: "↑",
  downrank: "↓",
  reply: "↩",
  repost: "↻"
};

const REACTION_LABELS: Record<ReactionKind, string> = {
  recommend: "recommend",
  downrank: "downrank",
  reply: "reply",
  repost: "repost"
};

function renderUnifiedFeedItem(item: UnifiedFeedItem): HTMLElement {
  const article = document.createElement("article");
  article.className = "stream-post";
  article.dataset["postId"] = item.post_id;

  const meta = document.createElement("div");
  meta.className = "stream-post__meta";

  const author = document.createElement("span");
  author.className = "stream-post__handle";
  author.textContent = item.author_handle ?? shortCanonical(item.author_canonical_id);

  const time = document.createElement("span");
  time.className = "stream-post__time";
  time.textContent = formatPostTimestamp(item.created_at);

  meta.append(author, time);

  const body = document.createElement("div");
  body.className = "stream-post__body";
  mountTextSurface(body, item.body, { font: BODY_FONT, lineHeight: 23 });

  const actions = document.createElement("div");
  actions.className = "stream-post__actions";
  const order: ReactionKind[] = ["recommend", "downrank", "reply", "repost"];
  for (const kind of order) {
    actions.append(renderReactionButton(kind, item.counts[kind]));
  }

  article.append(meta, body, actions);
  return article;
}

function renderReactionButton(kind: ReactionKind, count: number): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `stream-post__action stream-post__action--${kind}`;
  button.dataset["reaction"] = kind;
  button.setAttribute("aria-label", REACTION_LABELS[kind]);

  const glyph = document.createElement("span");
  glyph.className = "stream-post__action-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = REACTION_GLYPHS[kind];

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
    root.replaceChildren(line("no chats yet", "lookup__empty"));
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
  addedCanonicals: Set<string>,
  pendingAddedCanonicals: Set<string>,
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
    const isAdded = addedCanonicals.has(result.canonical);
    const isPendingAdded = pendingAddedCanonicals.has(result.canonical);
    const row = block("search-result", [
      line(result.handle, "search-result__handle"),
      line(result.bio, "is-muted"),
      line(`fingerprint: ${result.fingerprint}`, "is-muted"),
      line(`relationship: ${result.relationship?.tier ?? "unknown"}`, "is-muted"),
    ]);
    if (result.fingerprint_grid !== undefined) {
      row.prepend(renderFingerprintGrid(result.fingerprint_grid));
    }
    const button = document.createElement("button");
    button.className = "search-result__add";
    button.type = "button";
    button.textContent = isPendingAdded ? "added" : isAdded ? "remove" : "+";
    button.disabled = isPendingAdded;
    button.addEventListener("click", () => onToggle(result));
    row.append(button);
    fragment.append(row);
  }

  root.replaceChildren(fragment);
}



function renderResolvedIdentity(
  identity: IdentityDocument,
  fingerprint: string,
  relationship?: ConnectionRelationship,
  subscription?: FeedSubscription | null
): HTMLElement {
  const shortFingerprint = `${fingerprint.slice(0, 12)}...`;
  const card = block("lookup-card", [
    line(identity.handle, "lookup-card__handle"),
    line(`canonical: ${shortCanonical(identity.canonical_id)}`),
    line(`fingerprint: ${identity.visual_fingerprint?.fingerprint ?? shortFingerprint}`),
    line(`relationship: ${relationship?.tier ?? "unknown"}${relationship?.subscribed ? " / subscribed" : ""}`, "is-muted"),
    line(`subscription: ${subscription === null ? "none" : subscription?.muted ? "muted" : "active"}`, "is-muted"),
    line("trust: unverified", "is-muted"),
    line("onion: unknown", "is-muted"),
    line(`updated: ${formatTimestamp(identity.updated_at)}`, "is-muted"),
  ]);

  const actions = document.createElement("div");
  actions.className = "lookup-card__actions";
  actions.append(
    button("known", "set-known"),
    button("close", "set-close"),
    button("block", "set-block"),
    button("unblock", "set-unblock"),
    button("subscribe", "set-subscribe"),
    button("unsubscribe", "set-unsubscribe"),
  );
  card.append(actions);

  if (identity.visual_fingerprint !== undefined) {
    card.prepend(renderFingerprintGrid(identity.visual_fingerprint));
  }

  return card;
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

  const handle = document.createElement("div");
  handle.className = "chat-row__handle";
  handle.textContent = chat.handle;

  row.append(handle);

  if (chat.lastLine && chat.lastLine.length > 0) {
    const preview = document.createElement("div");
    preview.className = "chat-row__preview";
    preview.textContent = chat.lastLine;
    row.append(preview);
  }

  return row;
}

function renderFingerprintGrid(fingerprint: IdentityFingerprint): HTMLElement {
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
  element.textContent = label;
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

function formatPostTimestamp(value: string): string {
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

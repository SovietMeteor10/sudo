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
export type VoteKind = "like" | "dislike" | null;
export type ReactionCounts = {
  recommend: number;
  downrank: number;
  reply: number;
  repost: number;
};
export type EmbeddedFeedItem = {
  post_id: string;
  author_canonical_id: string;
  author_handle?: string;
  body: string;
  created_at: string;
  unavailable?: false;
} | { unavailable: true };
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

export function feedPostToUnifiedItem(
  post: FeedPost,
  enrichment: { counts?: ReactionCounts; vote?: VoteKind; viewerHasReposted?: boolean } = {}
): UnifiedFeedItem {
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
    counts: enrichment.counts ?? { ...ZERO_COUNTS },
    vote: enrichment.vote ?? null,
    kind: post.kind ?? "post",
    repost_of: post.repost_of === undefined ? undefined
      : embeddedFromMaybe(post.repost_of_post),
    reply_to: post.reply_to === undefined ? undefined
      : embeddedFromMaybe(post.reply_to_post),
    viewer_has_reposted: enrichment.viewerHasReposted ?? false
  };
}

function embeddedFromMaybe(post: FeedPost | null | undefined): EmbeddedFeedItem {
  if (post === null || post === undefined) return { unavailable: true };
  const body = post.body
    ?? post.public_metadata?.summary
    ?? post.public_metadata?.title
    ?? "[encrypted body]";
  return {
    post_id: post.post_id,
    author_canonical_id: post.author_canonical_id,
    author_handle: post.author_handle,
    body,
    created_at: post.created_at
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
    },
    vote: post.viewer_reaction === "recommend" ? "like"
      : post.viewer_reaction === "downrank" ? "dislike"
      : null,
    kind: "post",
    viewer_has_reposted: post.viewer_has_reposted ?? false
  };
}

function renderUnifiedFeedItem(item: UnifiedFeedItem): HTMLElement {
  const article = document.createElement("article");
  article.className = `stream-post stream-post--${item.kind ?? "post"}`;
  article.dataset["postId"] = item.post_id;
  if (item.kind !== undefined) article.dataset["postKind"] = item.kind;

  const meta = document.createElement("div");
  meta.className = "stream-post__meta";

  const author = document.createElement("span");
  author.className = "stream-post__handle";
  const authorLabel = item.author_handle ?? shortCanonical(item.author_canonical_id);
  author.textContent = item.kind === "repost"
    ? `${authorLabel} reposted`
    : item.kind === "reply"
      ? `${authorLabel} replied`
      : authorLabel;

  const time = document.createElement("span");
  time.className = "stream-post__time";
  time.textContent = formatPostTimestamp(item.created_at);

  meta.append(author, time);
  article.append(meta);

  // For replies, show parent context as a small "replying to @author"
  // line so the reply makes sense inline.
  if (item.kind === "reply" && item.reply_to !== undefined) {
    article.append(renderEmbeddedRef(item.reply_to, "replying to"));
  }

  // Reply body: render the user's own reply text (their commentary)
  // unless this is a quote-less repost.
  if (item.kind !== "repost" || item.body.length > 0 && item.body !== "[encrypted body]") {
    const body = document.createElement("div");
    body.className = "stream-post__body";
    mountTextSurface(body, item.body, { font: BODY_FONT, lineHeight: 23 });
    article.append(body);
  }

  // Repost: show the embedded original card.
  if (item.kind === "repost" && item.repost_of !== undefined) {
    article.append(renderEmbeddedOriginal(item.repost_of));
  }

  const actions = document.createElement("div");
  actions.className = "stream-post__actions";
  actions.append(renderVoteButton(item.counts, item.vote));
  actions.append(renderActionButton("reply", "↩", item.counts.reply));
  actions.append(renderActionButton("repost", "↻", item.counts.repost, item.viewer_has_reposted === true));
  article.append(actions);

  // Container for the inline reply composer / expanded replies list,
  // populated lazily by the controller when the user clicks ↩.
  const repliesPanel = document.createElement("div");
  repliesPanel.className = "stream-post__replies";
  repliesPanel.dataset["repliesPanel"] = item.post_id;
  repliesPanel.hidden = true;
  article.append(repliesPanel);

  return article;
}

function renderEmbeddedRef(ref: EmbeddedFeedItem, prefix: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "stream-post__ref";
  if (ref.unavailable === true) {
    wrapper.textContent = `${prefix} (original post unavailable)`;
    return wrapper;
  }
  const handle = ref.author_handle ?? shortCanonical(ref.author_canonical_id);
  wrapper.textContent = `${prefix} ${handle}`;
  return wrapper;
}

function renderEmbeddedOriginal(ref: EmbeddedFeedItem): HTMLElement {
  const card = document.createElement("blockquote");
  card.className = "stream-post__embed";
  if (ref.unavailable === true) {
    card.textContent = "original post unavailable";
    return card;
  }
  const handle = document.createElement("div");
  handle.className = "stream-post__embed-handle";
  handle.textContent = ref.author_handle ?? shortCanonical(ref.author_canonical_id);
  const body = document.createElement("div");
  body.className = "stream-post__embed-body";
  body.textContent = ref.body;
  card.append(handle, body);
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

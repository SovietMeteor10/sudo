import { streamPosts } from "./data.js";
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
  StreamPost
} from "./types.js";

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

  if (state.status === "error") {
    root.replaceChildren(line(state.message, "is-danger"));
    return;
  }

  root.replaceChildren(line(`signed in as ${state.identity.handle}`, "signup-result__label"));
}

export function renderStream(root: HTMLElement, feedPosts: FeedPost[] = []): void {
  unmountAllTextSurfaces();
  const fragment = document.createDocumentFragment();

  if (feedPosts.length === 0) {
    for (const post of streamPosts) {
      fragment.append(renderPost(post));
    }
  } else {
    for (const post of feedPosts) {
      fragment.append(renderFeedPost(post));
    }
  }

  root.replaceChildren(fragment);
}

export function renderDiscoveryPanel(
  root: HTMLElement,
  state: DiscoveryState,
  currentIdentityCanonicalId: string | null
): void {
  if (state.status === "idle" || state.status === "loading") {
    root.replaceChildren(
      discoveryToolbar(state.mode),
      line("loading discovery...", "lookup__empty")
    );
    return;
  }

  if (state.status === "error") {
    root.replaceChildren(
      discoveryToolbar(state.mode),
      block("lookup-card lookup-card--error", [
        line(state.message, "is-danger")
      ]),
    );
    return;
  }

  const fragment = document.createDocumentFragment();
  fragment.append(discoveryToolbar(state.mode));

  if (state.posts.length === 0) {
    fragment.append(line("no discoverable posts", "lookup__empty"));
    root.replaceChildren(fragment);
    return;
  }

  for (const post of state.posts) {
    fragment.append(renderDiscoveryPost(post, currentIdentityCanonicalId));
  }

  root.replaceChildren(fragment);
}

export function renderLookupResult(root: HTMLElement, state: LookupState): void {
  if (state.status === "idle") {
    root.replaceChildren(line("type a handle to resolve identity", "lookup__empty"));
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
  const fragment = document.createDocumentFragment();

  if (localChats.length === 0) {
    root.replaceChildren(line("no connections yet", "lookup__empty"));
    return;
  }

  for (const chat of localChats) {
    fragment.append(renderChat(chat));
  }

  root.replaceChildren(fragment);
  // TODO: hydrate active chats from encrypted inbox metadata after recipient authentication exists.
  // TODO: wire compose/decrypt/send flows to local keys; plaintext must stay client-side only.
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

function renderPost(post: StreamPost): HTMLElement {
  const article = document.createElement("article");
  article.className = "stream-post";

  const meta = document.createElement("div");
  meta.className = "stream-post__meta";
  meta.textContent = `${post.at}  ${post.handle}`;

  const body = document.createElement("div");
  body.className = "stream-post__body";
  mountTextSurface(body, post.body, { font: BODY_FONT, lineHeight: 23 });

  article.append(meta, body);
  return article;
}

function renderFeedPost(post: FeedPost): HTMLElement {
  const article = document.createElement("article");
  article.className = "stream-post";

  const meta = document.createElement("div");
  meta.className = "stream-post__meta";
  meta.textContent = `${formatTimestamp(post.created_at)}  ${post.author_handle ?? shortCanonical(post.author_canonical_id)}  [${post.visibility}]`;

  const body = document.createElement("div");
  body.className = "stream-post__body";
  const text = post.body
    ?? post.public_metadata.summary
    ?? post.public_metadata.title
    ?? "[encrypted body]";
  mountTextSurface(body, text, { font: BODY_FONT, lineHeight: 23 });

  article.append(meta, body);
  return article;
}

function renderDiscoveryPost(post: DiscoveryPostIndex, currentIdentityCanonicalId: string | null): HTMLElement {
  const article = block("discovery-card", [
    line(`${post.author_handle ?? shortCanonical(post.author_canonical_id)}  [${post.visibility}]`, "discovery-card__handle"),
    line(post.body_excerpt.length > 0 ? post.body_excerpt : "[no excerpt]", "discovery-card__excerpt"),
    line(post.explanation, "is-muted"),
    line(`hot ${post.hot_score.toFixed(3)}  rising ${post.rising_score.toFixed(3)}`, "is-muted"),
    line(`reactions: +${post.recommend_count} -${post.downrank_count} replies ${post.reply_count} reposts ${post.repost_count} reports ${post.report_count}`, "is-muted"),
  ]);
  article.dataset["postId"] = post.post_id;

  if (post.author_fingerprint_grid !== undefined) {
    article.prepend(renderFingerprintGrid(post.author_fingerprint_grid));
  }

  const actions = document.createElement("div");
  actions.className = "lookup-card__actions";
  actions.append(
    discoveryButton("recommend", "recommend", currentIdentityCanonicalId),
    discoveryButton("downrank", "downrank", currentIdentityCanonicalId),
    discoveryButton("repost", "repost", currentIdentityCanonicalId),
    discoveryButton("report", "report", currentIdentityCanonicalId),
  );
  article.append(actions);
  return article;
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
  row.dataset["chatCanonical"] = chat.canonical;
  row.dataset["chatHandle"] = chat.handle;
  if (chat.fingerprint !== undefined) row.dataset["chatFingerprint"] = chat.fingerprint;

  const handle = document.createElement("div");
  handle.className = "chat-row__handle";
  handle.textContent = chat.handle;

  const preview = document.createElement("div");
  preview.className = "chat-row__preview";
  preview.textContent = chat.lastLine;

  row.append(handle, preview);
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

function discoveryButton(label: string, reaction: string, currentIdentityCanonicalId: string | null): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "lookup-card__button";
  element.dataset["discoveryReaction"] = reaction;
  element.textContent = label;
  element.disabled = currentIdentityCanonicalId === null;
  if (currentIdentityCanonicalId === null) {
    element.title = "sign in to react";
  }
  return element;
}

function discoveryToolbar(mode: DiscoveryState["mode"]): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "discovery-toolbar";

  const label = document.createElement("div");
  label.className = "discovery-toolbar__label";
  label.textContent = "public discovery index";

  const modes = document.createElement("div");
  modes.className = "discovery-toolbar__modes";
  for (const item of ["recent", "rising", "hot"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = item === mode ? "lookup-card__button is-active" : "lookup-card__button";
    button.dataset["discoveryMode"] = item;
    button.textContent = item;
    modes.append(button);
  }

  wrapper.append(label, modes);
  return wrapper;
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

function shortCanonical(value: string): string {
  if (value.length <= 24) return value;
  return `${value.slice(0, 18)}...${value.slice(-6)}`;
}

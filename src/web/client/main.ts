import { localIdentity } from "./data.js";
import { BrowserPasskeyAccessProvider } from "./accessProviders.js";
import {
  registerIdentityDocument,
  cancelPairing,
  clearDiscoveryVote,
  createDiscoveryReaction,
  completeDevicePairing,
  deleteConnectionRelationship,
  createFeedPost,
  fetchIdentityProfile,
  fetchPairHandoffBundle,
  postPairHandoffBundle,
  FeedPostError,
  getDiscoveryPost,
  getFeedThread,
  listDiscoveryPosts,
  getConnectionRelationship,
  fingerprintPublicKey,
  listConnections,
  listFeedPostReplies,
  listFeedSubscriptions,
  listPersonalFeed,
  listUserFeedPosts,
  lookupHandle,
  normalizeLookupInput,
  getNodeDocument,
  listTrustedDevices as listServerTrustedDevices,
  listServerDeviceMemberships,
  revokeTrustedDevice as revokeServerTrustedDevice,
  registerTrustedDevice,
  startDevicePairing,
  exchangeChallengeForSession,
  fetchIdentityChallenge,
  restoreDevSession,
  searchHandles,
  upsertConnectionRelationship,
  type FeedEngagement
} from "./api.js";
import {
  createBrowserCryptoAccount,
  getUnlockedBrowserCryptoAccount,
  lockBrowserCryptoAccount,
  storeBrowserCryptoAccount,
  unlockBrowserCryptoAccount,
  type BrowserCryptoAccount
} from "./crypto/key-storage.js";
import { signDeviceMembership, signDiscoveryReaction, signFeedPost, signSessionChallenge } from "./crypto/signing.js";
import {
  buildAndPostSyncEvent,
  clearActiveCoordinator,
  setActiveCoordinator,
  startPolling as startContactSyncPolling
} from "./sync/coordinator.js";
import { notifyMessageUpsert } from "./sync/messageSync.js";
// Side-effect import: registers the draft slice projector at module
// load. The broadcast wrappers (applyDraftUpsertWithBroadcast,
// applyDraftDeleteWithBroadcast) aren't called from main yet because
// no UI flow writes drafts; without this import TypeScript elides the
// module and the projector never registers, so peers can't apply
// inbound draft events.
import "./sync/draftSync.js";
import { applyProfileUpsertWithBroadcast } from "./sync/profileSync.js";
import {
  applyContactDeleteWithBroadcast,
  applyContactUpsertWithBroadcast
} from "./sync/contactSync.js";
import {
  applySubscriptionDeleteWithBroadcast,
  applySubscriptionUpsertWithBroadcast
} from "./sync/subscriptionSync.js";
import {
  startNotificationsPolling,
  stopNotificationsPolling
} from "./notifications/notificationsClient.js";
import {
  feedPostToUnifiedItem,
  formatPostTimestamp,
  renderChatList,
  renderDiscoveryPanel,
  renderDevicePanel,
  renderFingerprintGrid,
  renderLookupResult,
  renderSearchResults,
  renderSigninState,
  renderSignupState,
  renderStream,
  type ReactionKind
} from "./components.js";
import {
  clearDevSessionToken,
  readDevSessionToken,
  writeDevSessionToken
} from "./localState.js";
import { createEncryptedBackup, importEncryptedBackup, type EncryptedSudoBackup } from "./local/backup.js";
import { gridFromFingerprintHex } from "./local/fingerprint.js";
import { encodeUrlToQrSvg } from "./local/qr-encoder.js";
import { base64Url, base64UrlToBytes, randomBytes, deriveBackupKey, toBufferSource } from "./local/crypto.js";
import {
  clearLocalDb,
  deleteCryptoAccount,
  deleteLocalContact,
  getBackfillState,
  getLocalStorageStatus,
  getSetting,
  initializeLocalState,
  listContacts as listLocalContacts,
  listConversations,
  listCryptoAccounts,
  listLocalDrafts,
  listLocalMessages,
  listLocalMessagesByConversation,
  listLocalSubscriptions,
  listPendingBackfills,
  listTrustedDevices,
  getLocalDeviceMetadata,
  putBackfillState,
  putSetting,
  revokeTrustedDevice,
  saveIdentitySeen,
  saveTrustedDevice,
  upsertContact
} from "./local/local-store.js";
import { deleteLocalDb, isLocalDatabaseError, LocalDatabaseError, probeLocalDbWritable, resetCachedLocalDb, subscribeLocalStateBroadcasts, broadcastLocalStateChange, type LocalStateChangeKind } from "./local/local-db.js";
import { queueAndSubmitLocalMessage, retrieveRelayInboxAfterLocalSave } from "./local/relay-local.js";
import type {
  ChatSummary,
  ConnectionRelationship,
  DiscoveryMode,
  DiscoveryState,
  FeedPost,
  FeedSubscription,
  IdentityDocument,
  NodeCapabilityDocument,
  LocalIdentity,
  LookupState,
  SearchResult,
  SearchState,
  SigninState,
  SignupState
} from "./types.js";
import { describePortalTransport, selectRelayForRecipient } from "./transport/relay-transport.js";

// Notifications panel is a non-critical UI surface — keep the
// lookups optional so a missing or future-shape index.html cannot
// kill module init and strand the landing auth buttons. If either
// element is absent the start/stop helpers below short-circuit; the
// rest of the app keeps working.
const notificationsList = document.getElementById("notifications-list");
const notificationsEmpty = document.getElementById("notifications-empty");
const notificationsClearAllRaw = document.getElementById("notifications-clear-all");
const notificationsClearAll = notificationsClearAllRaw instanceof HTMLButtonElement
  ? notificationsClearAllRaw
  : null;
const streamRoot = getRequiredElement("stream-list");
const feedComposer = getRequiredForm("feed-composer");
const feedBodyInput = getRequiredTextArea("feed-body");
const feedComposerState = getRequiredElement("feed-composer-state");
const lookupRoot = getRequiredElement("lookup-result");
const searchResultsRoot = getRequiredElement("search-results");
const chatsRoot = getRequiredElement("chat-list");
const discoveryRoot = getRequiredElement("discovery-list");
const searchForm = getRequiredForm("lookup-form");
const searchInput = getRequiredInput("lookup-input");
const feedTabButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-feed-tab]")];
const feedPanes = [...document.querySelectorAll<HTMLElement>("[data-feed-pane]")];
const accountButton = getRequiredButton("account-button");
const accountButtonHandle = getRequiredElement("account-button-handle");
const accountMenu = getRequiredElement("account-menu");
const accountMenuHandle = getRequiredElement("account-menu-handle");
const accountMenuRecovery = getRequiredElement("account-menu-recovery");
// recovery reminder banner removed in the new-device-link UX pass —
// it was the yellow strip the user objected to. See the no-op
// stubs further down.
const accountMenuAccount = getRequiredButton("account-menu-account");
const accountMenuSettings = getRequiredButton("account-menu-settings");
const accountMenuLogout = getRequiredButton("account-menu-logout");
const devicesDialog = getRequiredDialog("devices-dialog");
const devicesCancel = getRequiredButton("devices-cancel");
const settingsDialog = getRequiredDialog("settings-dialog");
const settingsBackupButton = getRequiredButton("settings-backup");
const settingsRestoreButton = getRequiredButton("settings-restore");
const settingsDevicesButton = getRequiredButton("settings-devices");
const settingsResetConfirmInput = getRequiredInput("settings-reset-confirm");
const settingsResetButton = getRequiredButton("settings-reset");
const settingsCancel = getRequiredButton("settings-cancel");
const settingsState = getRequiredElement("settings-state");
const accountDialog = getRequiredDialog("account-dialog");
const accountCardHandle = getRequiredElement("account-card-handle");
const accountCardFingerprintGrid = getRequiredElement("account-card-fingerprint-grid");
const accountCardFingerprintText = getRequiredElement("account-card-fingerprint-text");
const accountCardStatus = getRequiredElement("account-card-status");
const accountCardCanonical = getRequiredElement("account-card-canonical");
const accountBioInput = document.getElementById("account-bio") as HTMLTextAreaElement | null;
const accountSaveBio = getRequiredButton("account-save-bio");
const accountCancel = getRequiredButton("account-cancel");
const accountState = getRequiredElement("account-state");
const removeConnectionDialog = getRequiredDialog("remove-connection-dialog");
const removeConnectionCancel = getRequiredButton("remove-connection-cancel");
const removeConnectionConfirm = getRequiredButton("remove-connection-confirm");
const chatPopup = getRequiredElement("chat-popup");
const chatPopupHeader = getRequiredElement("chat-popup-header");
const chatPopupHandle = getRequiredElement("chat-popup-handle");
const chatPopupBody = getRequiredElement("chat-popup-body");
const chatPopupForm = getRequiredForm("chat-popup-form");
const chatPopupInput = getRequiredTextArea("chat-popup-input");
const chatPopupClose = getRequiredButton("chat-popup-close");
const signupCancel = getRequiredButton("signup-cancel");
const signupDialog = getRequiredDialog("signup-dialog");
const signupForm = getRequiredForm("signup-form");
const signupInput = getRequiredInput("signup-handle");
const signupPasswordInput = getRequiredInput("signup-password");
const signupPasswordConfirmInput = getRequiredInput("signup-password-confirm");
const signupStateRoot = getRequiredElement("signup-state");
const signupPasskeySupport = getRequiredElement("signup-passkey-support");
const signinCancel = getRequiredButton("signin-cancel");
const signinDialog = getRequiredDialog("signin-dialog");
const signinForm = getRequiredForm("signin-form");
const signinHandleInput = getRequiredInput("signin-handle");
const signinPasswordInput = getRequiredInput("signin-password");
const signinStateRoot = getRequiredElement("signin-state");
const signinPasskeySupport = getRequiredElement("signin-passkey-support");
const signinSubmit = getRequiredButton("signin-submit");
const restoreCancel = getRequiredButton("restore-cancel");
const restoreDialog = getRequiredDialog("restore-dialog");
const restoreForm = getRequiredForm("restore-form");
const restoreFileInput = getRequiredInput("restore-file");
const restorePassphraseInput = getRequiredInput("restore-passphrase");
const restoreStateRoot = getRequiredElement("restore-state");
const restoreSubmit = getRequiredButton("restore-submit");
const localStateStatus = getRequiredElement("local-storage-status");
const deviceCurrentStatus = getRequiredElement("device-current-status");
const deviceList = getRequiredElement("device-list");
const deviceLinkStart = getRequiredButton("device-link-start");
const devicePanelFeedback = getRequiredElement("device-panel-feedback");
const pairingCard = getRequiredElement("pairing-card");
const pairingCardCode = getRequiredElement("pairing-card-code");
const pairingCardUrl = getRequiredElement("pairing-card-url");
const pairingCardExpires = getRequiredElement("pairing-card-expires");
const pairingCardCancel = getRequiredButton("pairing-card-cancel");
const pairingCardQr = getRequiredElement("pairing-card-qr");
const pairingCardSuccess = getRequiredElement("pairing-card-success");
const linkDeviceDialog = getRequiredDialog("link-device-dialog");
const linkDeviceForm = getRequiredForm("link-device-form");
const linkDeviceCode = getRequiredInput("link-device-code");
const linkDevicePassphrase = getRequiredInput("link-device-passphrase");
const linkDeviceOwner = getRequiredElement("link-device-owner");
const linkDeviceState = getRequiredElement("link-device-state");
const linkDeviceCancel = getRequiredButton("link-device-cancel");
const linkDeviceSubmit = getRequiredButton("link-device-submit");
const localMaintenanceFeedback = getRequiredElement("local-maintenance-feedback");
const authActionButtons = [...document.querySelectorAll("[data-auth-action]")];
const landingBrand = getRequiredButton("landing-brand");
// Optional landing-screen extras — these are defensive lookups so a
// missing element doesn't strand the auth wiring (we got burned by
// getRequiredElement on optional notification panels before).
const landingStaleBanner = document.getElementById("landing-stale");
// landing-reset removed in the UX cleanup — reset now lives inside
// the settings dialog under "danger zone" with a typed-RESET confirm.

const passkeyAccessProvider = new BrowserPasskeyAccessProvider();

let lookupState: LookupState = { status: "idle" };
let signupState: SignupState = { status: "idle" };
let signinState: SigninState = { status: "idle" };
let searchState: SearchState = { status: "idle" };
// Discover tab uses one default ordering and never exposes mode toggles
// to the UI. "rising" is the closest to "trending right now".
let discoveryState: DiscoveryState = { status: "idle", mode: "rising" };
let currentIdentity: LocalIdentity = localIdentity;
let currentIdentityDocument: IdentityDocument | null = null;
let currentIdentityFingerprint: string | null = null;
let currentCryptoAccount: BrowserCryptoAccount | null = null;
let currentLookupRelationship: ConnectionRelationship | null = null;
let currentLookupSubscription: FeedSubscription | null = null;
let currentNodeDocument: NodeCapabilityDocument | null = null;
let currentDeviceId: string | null = null;
let activePairingCode: string | null = null;
let activePairingToken: string | null = null;
let activePairingExpiresAt: string | null = null;
let pairingExpiresInterval: number | null = null;
let localChats: ChatSummary[] = [];
const pendingAddedCanonicals = new Set<string>();
const pendingAddedTimers = new Map<string, number>();
let activeLookup: AbortController | null = null;
let activeSearch: AbortController | null = null;
let searchDebounce: number | null = null;
let authSequence = 0;
let authView: "menu" | "signin" | "signup" | "restore" | "signed-in" = "menu";
let activeFeedTab: "personal" | "discover" = "personal";
let chatTarget: { canonical: string; handle: string; fingerprint: string } | null = null;
let brandFlickerTimeout: number | null = null;
let brandFlickerTick: number | null = null;
let brandFlickerActive = false;
const brandLabel = "sudo";
const brandFlickerPool = ["σ", "δ", "с", "д", "す", "ド", "س", "ו", "द", "ο", "そ", "ス", "ا", "א"];
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

renderLookupResult(lookupRoot, lookupState);
renderSignupState(signupStateRoot, signupState);
renderSigninState(signinStateRoot, signinState);
renderChatList(chatsRoot, localChats);
renderDiscoveryPanel(discoveryRoot, discoveryState, viewerCanonicalIdOrUndefined());
renderSearchResults(searchResultsRoot, searchState, getFollowedCanonicals(), pendingAddedCanonicals, toggleChatTarget);
renderPasskeySupport();
landingBrand.textContent = brandLabel;
setFeedTab("personal");
void initializeLocalRuntime();
void refreshNodeDocument();
void renderStreamWhenReady();
void refreshDiscoveryPosts();
void restoreStoredSession();

// Auto-open the collect-account dialog if the page loaded with
// ?collect=CODE (canonical) or ?pair=CODE (legacy) in the URL.
// Lets a new device land directly on the linking step from a QR
// scan on the trusted device.
void (async () => {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("collect") ?? params.get("pair");
    if (code && code.length > 0) {
      // Don't pre-open if the user is already signed in on this
      // device — that suggests they accidentally re-loaded the
      // collect URL on the same browser. Show a clear note instead.
      if (document.body.dataset.authState === "signed-in") {
        flashFeedback("you are already signed in on this device.");
      } else {
        openLinkDeviceDialog(code);
      }
      // Strip both possible params so a reload doesn't keep popping
      // the dialog after the user dismissed it.
      const url = new URL(window.location.href);
      url.searchParams.delete("collect");
      url.searchParams.delete("pair");
      window.history.replaceState(null, "", url.toString());
    }
  } catch { /* ignore */ }
})();

// Listen for sibling tabs (same owner) signalling local-state changes.
// Cross-tab updates keep two open tabs of the same account in sync
// without each one re-polling the server independently.
subscribeLocalStateBroadcasts((event) => {
  if (currentIdentityDocument === null) return;
  if (event.ownerCanonicalId !== currentIdentityDocument.canonical_id) return;
  void onSiblingLocalStateChange(event.kind);
});

async function onSiblingLocalStateChange(kind: LocalStateChangeKind): Promise<void> {
  if (kind === "messages") {
    await refreshLocalChats();
    if (chatTarget !== null && !chatPopup.hidden) {
      await renderChatPopupBody(chatTarget.canonical);
    }
    return;
  }
  if (kind === "contacts") {
    await refreshLocalChats();
    return;
  }
  if (kind === "feed") {
    await refreshFeedPosts();
    return;
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runLookup(searchInput.value);
});

searchInput.addEventListener("input", () => {
  const value = searchInput.value.trim();
  if (value === "") {
    activeLookup?.abort();
    activeSearch?.abort();
    setLookupState({ status: "idle" });
    setSearchState({ status: "idle" });
    return;
  }

  scheduleSearch(value);
});

lookupRoot.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const action = target.dataset["relationshipAction"];
  if (action === undefined) return;
  void handleLookupRelationshipAction(action, target);
});

// Both the personal feed and the discover feed render through the same
// .stream-post component, so action clicks are delegated identically
// from either root. Clicking the post's main surface (meta/body) opens
// the focused thread view; action buttons trigger their own behavior.
const handleFeedClick = (event: Event): void => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  // Thread-view back button lives in the container, not in any
  // particular .stream-post. Dispatch first.
  const back = target.closest<HTMLButtonElement>("[data-thread-action='back']");
  if (back !== null) {
    exitThreadView();
    return;
  }

  const article = target.closest<HTMLElement>(".stream-post");
  const postId = article?.dataset["postId"];
  if (typeof postId !== "string") return;

  const voteButton = target.closest<HTMLButtonElement>(".stream-post__action--vote");
  if (voteButton !== null) {
    const state = voteButton.dataset["voteState"] ?? "neutral";
    void handleVoteCycle(postId, state);
    return;
  }

  // Branch collapse/expand toggle on threaded comments.
  const collapseButton = target.closest<HTMLButtonElement>(".stream-post__reply-collapse");
  if (collapseButton !== null) {
    toggleReplyBranch(collapseButton);
    return;
  }

  // Per-reply ↩ button: open a nested composer below that reply.
  const nestedOpen = target.closest<HTMLButtonElement>(
    ".stream-post__reply-action[data-reply-action='open-nested']"
  );
  if (nestedOpen !== null && article !== null) {
    const replyTarget = nestedOpen.dataset["replyTarget"];
    if (typeof replyTarget === "string") toggleNestedComposer(article, postId, replyTarget);
    return;
  }

  const submit = target.closest<HTMLButtonElement>(".stream-post__reply-submit");
  if (submit !== null && article !== null) {
    const replyTarget = submit.dataset["replyTarget"] ?? postId;
    void handleReplySubmit(postId, replyTarget, submit, article);
    return;
  }

  const actionButton = target.closest<HTMLButtonElement>(".stream-post__action[data-reaction]");
  if (actionButton !== null) {
    const reaction = actionButton.dataset["reaction"];
    if (reaction === "reply") {
      if (article !== null) toggleReplyComposer(postId, article);
      return;
    }
    if (reaction === "repost") {
      if (actionButton.dataset["alreadyReposted"] === "true") return;
      void handleRepost(postId);
      return;
    }
    return;
  }

  // Embedded original (the inset card inside a repost) navigates to
  // the original post's thread, regardless of whether we're currently
  // in the feed list or another thread. Action-button clicks above
  // already returned, so this only runs for body/handle/timestamp
  // clicks inside the embed.
  const embed = target.closest<HTMLElement>(".stream-post__embed[data-thread-open-embed='true']");
  if (embed !== null) {
    const embedTarget = embed.dataset["embedPostId"];
    if (typeof embedTarget === "string" && embedTarget.length > 0 && embedTarget !== postId) {
      void enterThreadView(embedTarget);
      return;
    }
  }

  // Fallthrough: clicks on the post's main click surface open the
  // focused thread view. Suppressed when we're already in thread
  // view — the parent post inside thread view shouldn't re-trigger
  // navigation.
  const main = target.closest<HTMLElement>(".stream-post__main[data-thread-open='true']");
  if (main !== null && activeThreadPostId === null) {
    void enterThreadView(postId);
    return;
  }
};

streamRoot.addEventListener("click", handleFeedClick);
discoveryRoot.addEventListener("click", handleFeedClick);

function toggleReplyBranch(button: HTMLButtonElement): void {
  const targetId = button.dataset["collapseTarget"];
  if (typeof targetId !== "string") return;
  const item = button.closest<HTMLElement>(".stream-post__reply-item");
  if (item === null) return;
  // The sublist now lives inside the reply's content wrapper rather
  // than directly under the grid item; selector traverses the content
  // column for the matching sublist marker.
  const sublist = item.querySelector<HTMLElement>(
    `:scope > .stream-post__reply-content > .stream-post__reply-list[data-sublist-for="${cssEscape(targetId)}"]`
  );
  if (sublist === null) return;
  const collapsed = button.dataset["collapsed"] === "true";
  if (collapsed) {
    sublist.hidden = false;
    button.textContent = "[-]";
    button.dataset["collapsed"] = "false";
    button.setAttribute("aria-label", "collapse replies");
  } else {
    sublist.hidden = true;
    button.textContent = "[+]";
    button.dataset["collapsed"] = "true";
    button.setAttribute("aria-label", "expand replies");
  }
}

deviceList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const action = target.dataset["deviceAction"];
  const deviceId = target.dataset["deviceId"];
  if (action === "revoke" && deviceId !== undefined) {
    void revokeDevice(deviceId);
  }
});

feedComposer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitFeedPost();
});

signupCancel.addEventListener("click", () => {
  signupDialog.close();
});

signupDialog.addEventListener("close", () => {
  clearSignupForm();
  if (authView !== "signed-in") {
    setAuthView("menu");
  }
});

signupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runSignup(
    signupInput.value,
    signupPasswordInput.value,
    signupPasswordConfirmInput.value,
    ""
  );
});

signinCancel.addEventListener("click", () => {
  signinDialog.close();
});

signinDialog.addEventListener("close", () => {
  clearSigninForm();
  if (authView !== "signed-in") {
    setAuthView("menu");
  }
});

signinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runSignin(signinHandleInput.value, signinPasswordInput.value);
});

restoreCancel.addEventListener("click", () => {
  restoreDialog.close();
});

restoreDialog.addEventListener("close", () => {
  clearRestoreForm();
  if (authView !== "signed-in") {
    openSigninDialog();
  }
});

restoreForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitRestoreAccount();
});

deviceLinkStart.addEventListener("click", () => {
  void startPairingFlow();
});

pairingCardCancel.addEventListener("click", () => {
  void cancelActivePairing();
});

linkDeviceCancel.addEventListener("click", () => {
  linkDeviceDialog.close();
});

linkDeviceForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runLinkExistingAccount();
});

for (const button of authActionButtons) {
  if (!(button instanceof HTMLButtonElement)) continue;
  button.addEventListener("click", () => {
    const action = button.dataset["authAction"];
    if (action === "signup") openSignupDialog();
    else if (action === "restore") openRestoreDialog();
    else if (action === "link") openLinkDeviceDialog();
    else openSigninDialog();
  });
}

landingBrand.addEventListener("mouseenter", () => {
  void startBrandFlicker();
});

landingBrand.addEventListener("focus", () => {
  void startBrandFlicker();
});

landingBrand.addEventListener("mouseleave", () => {
  stopBrandFlicker();
});

landingBrand.addEventListener("blur", () => {
  stopBrandFlicker();
});

// ----- account dropdown menu -----
accountButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setAccountMenuOpen(accountMenu.hidden);
});

accountMenu.addEventListener("click", (event) => {
  event.stopPropagation();
});

document.addEventListener("click", (event) => {
  if (accountMenu.hidden) return;
  if (event.target instanceof Node && (accountMenu.contains(event.target) || accountButton.contains(event.target))) return;
  setAccountMenuOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !accountMenu.hidden) {
    setAccountMenuOpen(false);
  }
});

accountMenuAccount.addEventListener("click", () => {
  setAccountMenuOpen(false);
  void openAccountDialog();
});

accountMenuSettings.addEventListener("click", () => {
  setAccountMenuOpen(false);
  openSettingsDialog();
});

settingsBackupButton.addEventListener("click", () => {
  // Close settings before triggering the backup so the file-save
  // prompt and the toast feedback are both visible without the
  // modal in the way.
  settingsDialog.close();
  void exportEncryptedBackup();
});

settingsRestoreButton.addEventListener("click", () => {
  settingsDialog.close();
  openRestoreDialog();
});

settingsDevicesButton.addEventListener("click", () => {
  settingsDialog.close();
  openDevicesDialog();
});

settingsResetConfirmInput.addEventListener("input", () => {
  // Two-step destructive confirm: the reset button only enables when
  // the user has typed RESET exactly. Trim trailing whitespace so a
  // tab/enter doesn't keep it disabled.
  settingsResetButton.disabled = settingsResetConfirmInput.value.trim() !== "RESET";
});

settingsResetButton.addEventListener("click", () => {
  void runSettingsReset();
});

settingsCancel.addEventListener("click", () => {
  settingsDialog.close();
});

accountSaveBio.addEventListener("click", () => {
  void saveAccountBio();
});

accountCancel.addEventListener("click", () => {
  accountDialog.close();
});

accountMenuLogout.addEventListener("click", () => {
  setAccountMenuOpen(false);
  logout();
});

devicesCancel.addEventListener("click", () => {
  devicesDialog.close();
});

// ----- feed tabs -----
for (const button of feedTabButtons) {
  button.addEventListener("click", () => {
    const target = button.dataset["feedTab"];
    if (target === "personal" || target === "discover") setFeedTab(target);
  });
}

// ----- mobile bottom tabs -----
// Each button maps to a data-mobile-region on a column section; CSS
// at <=760px shows only the active region. Desktop layout ignores
// the data-mobile-pane attribute entirely, so this code does no harm
// at desktop widths.
const mobileTabButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-mobile-tab]")];
function setMobilePane(pane: string): void {
  document.body.dataset["mobilePane"] = pane;
  for (const button of mobileTabButtons) {
    button.classList.toggle("is-active", button.dataset["mobileTab"] === pane);
  }
}
for (const button of mobileTabButtons) {
  button.addEventListener("click", () => {
    const target = button.dataset["mobileTab"];
    if (typeof target !== "string" || target.length === 0) return;
    setMobilePane(target);
  });
}
// Default to feed.
setMobilePane(document.body.dataset["mobilePane"] ?? "feed");

// ----- chat popup -----
chatPopupClose.addEventListener("click", () => {
  closeChatPopup();
});

// Click anywhere in the popup header (except the close button) to collapse
// or expand the body — replaces the dedicated minimize icon.
chatPopupHeader.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("#chat-popup-close")) return;
  chatPopup.classList.toggle("is-minimized");
});

chatPopupHeader.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (event.target instanceof Element && event.target.closest("#chat-popup-close")) return;
  event.preventDefault();
  chatPopup.classList.toggle("is-minimized");
});

chatPopupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendChatPopupMessage();
});

chatPopupInput.addEventListener("input", () => autoGrowTextarea(chatPopupInput, 28, 120));
chatPopupInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendChatPopupMessage();
  }
});

chatsRoot.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest<HTMLElement>("[data-chat-canonical]");
  if (row === null) return;
  const canonical = row.dataset["chatCanonical"];
  const handle = row.dataset["chatHandle"] ?? "";
  const fingerprint = row.dataset["chatFingerprint"] ?? "";
  if (canonical) void openChatPopup({ canonical, handle, fingerprint });
});

// ----- composer auto-grow + Cmd/Ctrl+Enter submit -----
feedBodyInput.addEventListener("input", () => {
  autoGrowTextarea(feedBodyInput, 32, 280);
  if (feedComposerState.textContent && feedComposerState.textContent.length > 0) {
    feedComposerState.textContent = "";
  }
});
feedBodyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    feedComposer.requestSubmit();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "/" && event.target === document.body) {
    event.preventDefault();
    searchInput.focus();
  }
});

async function initializeLocalRuntime(): Promise<void> {
  try {
    await initializeLocalState();
    await refreshLocalChats();
    await refreshLocalStorageStatus();
    await refreshDevicePanel();
  } catch (error) {
    localStateStatus.textContent = `local data: ${error instanceof Error ? error.message : "unavailable"}`;
  }
}

async function refreshLocalChats(): Promise<void> {
  if (currentIdentityDocument === null) {
    localChats = [];
    renderChatList(chatsRoot, localChats);
    return;
  }
  try {
    const conversations = await listConversations(currentIdentityDocument.canonical_id);
    localChats = conversations.map((conversation) => ({
      id: `local-${conversation.canonical}`,
      canonical: conversation.canonical,
      handle: conversation.handle && conversation.handle.length > 0
        ? conversation.handle
        : conversation.canonical,
      state: "draft" as const,
      lastLine: conversation.lastLine,
      fingerprint: conversation.fingerprint
    }));
  } catch {
    localChats = [];
  }
  renderChatList(chatsRoot, localChats);
}

// ---- inbox polling ---------------------------------------------------------
// Multi-tab safe: at most one tab per (browser profile, owner) is the
// inbox-poll leader at any moment. The leader claims a localStorage
// lease keyed by owner_canonical_id and renews it every few seconds.
// Followers skip the relay fetch entirely; they pick up new messages
// via the local-state-changed broadcast that the leader fires after
// saving each envelope. This eliminates duplicate ACKs and duplicate
// notification beeps when the same account is open in multiple tabs.
const INBOX_POLL_INTERVAL_MS = 5000;
const INBOX_LEADER_LEASE_MS = 9000;     // leader entry expires after this
const INBOX_LEADER_RENEW_MS = 4000;     // leader renews this often
const TAB_ID = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
let inboxPollTimer: number | null = null;
let inboxPollOwner: string | null = null;
let inboxInitialPollDone = false;
let inboxPollInFlight = false;

function leaderKey(owner: string): string {
  return `sudo.poll.leader.${owner}`;
}

type LeaderEntry = { tabId: string; expiresAt: number };

function readLeader(owner: string): LeaderEntry | null {
  try {
    const raw = window.localStorage?.getItem(leaderKey(owner));
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed = JSON.parse(raw) as Partial<LeaderEntry>;
    if (typeof parsed.tabId !== "string" || typeof parsed.expiresAt !== "number") return null;
    return parsed as LeaderEntry;
  } catch {
    return null;
  }
}

function writeLeader(owner: string, entry: LeaderEntry): void {
  try { window.localStorage?.setItem(leaderKey(owner), JSON.stringify(entry)); } catch { /* ignore */ }
}

function clearLeaderIfOwned(owner: string): void {
  const current = readLeader(owner);
  if (current === null || current.tabId !== TAB_ID) return;
  try { window.localStorage?.removeItem(leaderKey(owner)); } catch { /* ignore */ }
}

// Try to become the inbox-poll leader for this owner, or renew the lease
// if we already are. Returns true iff we hold the lease afterwards.
function ensureInboxLeadership(owner: string): boolean {
  const now = Date.now();
  const current = readLeader(owner);
  if (current !== null && current.tabId !== TAB_ID && current.expiresAt > now) {
    return false; // someone else is leading; back off until their lease expires
  }
  writeLeader(owner, { tabId: TAB_ID, expiresAt: now + INBOX_LEADER_LEASE_MS });
  return true;
}

function startInboxPolling(canonicalId: string): void {
  stopInboxPolling();
  inboxPollOwner = canonicalId;
  inboxInitialPollDone = false;
  void pollInbox();
  inboxPollTimer = window.setInterval(() => {
    void pollInbox();
  }, INBOX_POLL_INTERVAL_MS);
  // Attempt to claim leadership at a faster cadence than the poll
  // interval so handoff to a follower happens quickly when the leader
  // closes its tab.
  window.setInterval(() => {
    if (inboxPollOwner !== null) ensureInboxLeadership(inboxPollOwner);
  }, INBOX_LEADER_RENEW_MS);
}

function stopInboxPolling(): void {
  if (inboxPollTimer !== null) {
    window.clearInterval(inboxPollTimer);
    inboxPollTimer = null;
  }
  if (inboxPollOwner !== null) clearLeaderIfOwned(inboxPollOwner);
  inboxPollOwner = null;
  inboxInitialPollDone = false;
}

// Best-effort: release the leader lease when the tab closes so a sibling
// tab takes over quickly instead of waiting out the full lease.
window.addEventListener("beforeunload", () => {
  if (inboxPollOwner !== null) clearLeaderIfOwned(inboxPollOwner);
  if (feedPollOwner !== null) clearFeedLeaderIfOwned(feedPollOwner);
});

// ---- personal-feed polling -------------------------------------------------
// Same shape as inbox polling above: at most one tab per (browser profile,
// owner) hits /api/feeds/personal on a timer. Followers receive new posts
// via the existing local-state-changed `feed` broadcast that the leader
// fires after detecting a real change. Conservative interval keeps the
// server load proportional to the (small) viewer-author graph.
const FEED_POLL_INTERVAL_MS = 12000;
const FEED_LEADER_LEASE_MS = 20000;
const FEED_LEADER_RENEW_MS = 8000;
let feedPollTimer: number | null = null;
let feedLeaderRenewTimer: number | null = null;
let feedPollOwner: string | null = null;
let feedPollInFlight = false;
// "fingerprint" of the last successfully applied feed snapshot. Used by
// the poller to detect *real* changes vs identical refetches so we
// don't broadcast no-op `feed` events to sibling tabs.
let lastFeedFingerprint: string | null = null;

function feedLeaderKey(owner: string): string {
  return `sudo.poll.feed-leader.${owner}`;
}

function readFeedLeader(owner: string): LeaderEntry | null {
  try {
    const raw = window.localStorage?.getItem(feedLeaderKey(owner));
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed = JSON.parse(raw) as Partial<LeaderEntry>;
    if (typeof parsed.tabId !== "string" || typeof parsed.expiresAt !== "number") return null;
    return parsed as LeaderEntry;
  } catch {
    return null;
  }
}

function writeFeedLeader(owner: string, entry: LeaderEntry): void {
  try { window.localStorage?.setItem(feedLeaderKey(owner), JSON.stringify(entry)); } catch { /* ignore */ }
}

function clearFeedLeaderIfOwned(owner: string): void {
  const current = readFeedLeader(owner);
  if (current === null || current.tabId !== TAB_ID) return;
  try { window.localStorage?.removeItem(feedLeaderKey(owner)); } catch { /* ignore */ }
}

function ensureFeedLeadership(owner: string): boolean {
  const now = Date.now();
  const current = readFeedLeader(owner);
  if (current !== null && current.tabId !== TAB_ID && current.expiresAt > now) {
    return false;
  }
  writeFeedLeader(owner, { tabId: TAB_ID, expiresAt: now + FEED_LEADER_LEASE_MS });
  return true;
}

function startFeedPolling(canonicalId: string): void {
  stopFeedPolling();
  feedPollOwner = canonicalId;
  // Poll immediately so the first cycle catches any posts that landed
  // between the initial /personal fetch and signed-in setup.
  void pollPersonalFeed();
  feedPollTimer = window.setInterval(() => {
    void pollPersonalFeed();
  }, FEED_POLL_INTERVAL_MS);
  feedLeaderRenewTimer = window.setInterval(() => {
    if (feedPollOwner !== null) ensureFeedLeadership(feedPollOwner);
  }, FEED_LEADER_RENEW_MS);
}

function stopFeedPolling(): void {
  if (feedPollTimer !== null) {
    window.clearInterval(feedPollTimer);
    feedPollTimer = null;
  }
  if (feedLeaderRenewTimer !== null) {
    window.clearInterval(feedLeaderRenewTimer);
    feedLeaderRenewTimer = null;
  }
  if (feedPollOwner !== null) clearFeedLeaderIfOwned(feedPollOwner);
  feedPollOwner = null;
  lastFeedFingerprint = null;
}

// Compact, order-sensitive fingerprint used to detect whether a polled
// snapshot differs from what's already on screen. The hash includes:
//   - post id + post.updated_at (catches edits / new top-level posts)
//   - engagement counts (recommend / downrank / reply / repost) so a
//     like/dislike/comment/repost on an already-visible card actually
//     triggers the poll-driven repaint
//   - viewer-relative engagement (the viewer's own vote and whether
//     they have reposted) so the heart/repost state flips on poll
//     even when the *count* hasn't moved
// Without the engagement bits, an arriving reply that doesn't bump
// post.updated_at gets silently dropped by the fingerprint diff and
// the visible card stays stale until something else mutates the post.
function computeFeedFingerprint(
  posts: FeedPost[],
  engagement: Record<string, FeedEngagement | undefined> = {}
): string {
  if (posts.length === 0) return "empty";
  return posts.map((post) => {
    const eng = engagement[post.post_id];
    const stamp = eng === undefined
      ? "0/0/0/0//0"
      : `${eng.counts.recommend}/${eng.counts.downrank}/${eng.counts.reply}/${eng.counts.repost}/${eng.viewer_reaction ?? ""}/${eng.viewer_has_reposted === true ? 1 : 0}`;
    return `${post.post_id}:${post.updated_at}:${stamp}`;
  }).join("|");
}

async function pollPersonalFeed(): Promise<void> {
  if (feedPollOwner === null) return;
  if (currentIdentityDocument === null) return;
  if (feedPollOwner !== currentIdentityDocument.canonical_id) return;
  if (feedPollInFlight) return;
  // Don't fight the thread view for the center column.
  if (activeThreadPostId !== null) return;
  // Don't poll while the tab is backgrounded — the visibilitychange
  // handler triggers an immediate poll when the user returns.
  if (typeof document !== "undefined" && document.hidden) return;
  // Followers rely on the leader's broadcast to learn about new posts.
  if (!ensureFeedLeadership(feedPollOwner)) return;

  feedPollInFlight = true;
  try {
    const response = await listPersonalFeed(feedPollOwner);
    if (currentIdentityDocument === null) return;
    if (feedPollOwner !== currentIdentityDocument.canonical_id) return;
    const fingerprint = computeFeedFingerprint(response.posts, response.engagement);
    if (fingerprint === lastFeedFingerprint) return;

    // Only advance the fingerprint when we *actually* paint the new
    // state. If we're not on the personal pane (or sitting in a
    // thread view), bumping the fingerprint here would silently
    // strand newer state — the next poll matches and renders
    // nothing, and the user has to reload. Setting the fingerprint
    // only after a render keeps "what's on screen" and "what we've
    // committed to" the same.
    if (activeThreadPostId === null && activeFeedTab === "personal") {
      const items = response.posts.map((post) => feedPostToUnifiedItemFromEngagement(
        post,
        response.engagement[post.post_id]
      ));
      renderStream(streamRoot, items);
      lastFeedFingerprint = fingerprint;
    }
    // Tell sibling tabs of this account to repaint from their own
    // refresh path so they don't all double-poll the server. The
    // broadcast still fires when the local pane was unrendered —
    // sibling tabs that ARE on personal will repaint themselves.
    broadcastLocalStateChange("feed", feedPollOwner);
  } catch {
    // Network blip; next tick retries.
  } finally {
    feedPollInFlight = false;
  }
}

// Wake the poller whenever the user comes back to the tab. We listen
// on both signals because they fire on different real-world paths:
//   - visibilitychange: the tab moves between fully-rendered and
//     fully-hidden (e.g. switched to a different tab in the same
//     window, window minimized).
//   - focus: the window receives focus from a peer browser window,
//     which on most platforms does NOT fire visibilitychange because
//     both windows remain visibilityState="visible".
// The user's reported "I had to reload to see B's post" case looked
// like the second path: two side-by-side browser windows, one
// becomes focused, neither was ever document.hidden. Polling on
// focus closes that gap.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (feedPollOwner === null) return;
    void pollPersonalFeed();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    if (feedPollOwner === null) return;
    void pollPersonalFeed();
  });
}

async function pollInbox(): Promise<void> {
  if (inboxPollOwner === null) return;
  if (currentIdentityDocument === null) return;
  if (inboxPollOwner !== currentIdentityDocument.canonical_id) return;
  if (inboxPollInFlight) return;
  // Only the elected leader actually fetches the relay. Followers rely
  // on local-state broadcasts from the leader to notice new messages.
  if (!ensureInboxLeadership(inboxPollOwner)) {
    inboxInitialPollDone = true;
    return;
  }
  inboxPollInFlight = true;
  try {
    const newMessages = await retrieveRelayInboxAfterLocalSave(inboxPollOwner);
    if (newMessages.length > 0) {
      await onIncomingMessages(newMessages);
    }
  } catch {
    // network blip; next tick retries
  } finally {
    inboxPollInFlight = false;
    inboxInitialPollDone = true;
  }
}

async function onIncomingMessages(messages: import("./local/local-types.js").LocalMessage[]): Promise<void> {
  if (currentIdentityDocument === null) return;
  const ownerCanonicalId = currentIdentityDocument.canonical_id;
  // Sender handle may be missing on stored row; surface it on the chat row
  // by upserting a contact entry so the chat list shows a real handle.
  for (const message of messages) {
    if (message.direction !== "received") continue;
    const handle = message.sender_handle ?? "";
    if (handle.length > 0) {
      try {
        await applyContactUpsertWithBroadcast(ownerCanonicalId, {
          canonical_id: message.sender_canonical_id,
          handle,
          tier: "unknown",
          added_at: message.created_at,
          updated_at: message.updated_at
        });
      } catch {
        // contact upsert is best-effort
      }
    }
  }

  await refreshLocalChats();

  const lastReceived = [...messages]
    .filter((message) => message.direction === "received")
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .pop();

  if (lastReceived !== undefined) {
    const senderCanonical = lastReceived.sender_canonical_id;
    const senderHandle = lastReceived.sender_handle ?? localChats.find((chat) => chat.canonical === senderCanonical)?.handle ?? senderCanonical;
    const senderFingerprint = localChats.find((chat) => chat.canonical === senderCanonical)?.fingerprint ?? "";

    if (chatTarget !== null && chatTarget.canonical === senderCanonical) {
      await renderChatPopupBody(senderCanonical);
    } else {
      await openChatPopup({ canonical: senderCanonical, handle: senderHandle, fingerprint: senderFingerprint });
    }

    // Only beep on truly new messages within an active session, never during
    // the initial historical fetch right after sign-in.
    if (inboxInitialPollDone) {
      void playIncomingMessageSound();
    }
  }
}

// ---- notification sound ----------------------------------------------------
let audioContext: AudioContext | null = null;
function playIncomingMessageSound(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return;
    if (audioContext === null) audioContext = new Ctor();
    if (audioContext.state === "suspended") {
      // Browser autoplay policy: only resume after a user gesture; silently
      // skip otherwise.
      void audioContext.resume().catch(() => null);
      if (audioContext.state === "suspended") return;
    }
    const ctx = audioContext;
    const start = ctx.currentTime;

    // Two-tone ascending chime (E5 -> A5). Short, pleasant, hard to ignore
    // without being shrill. Both tones share an envelope shape; second tone
    // starts as the first one fades.
    const tone = (frequency: number, startAt: number, duration: number, peak: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(peak, startAt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    };

    tone(659.25, start, 0.11, 0.28);          // E5
    tone(880.0, start + 0.09, 0.16, 0.28);    // A5
  } catch {
    // never break the app over a sound
  }
}

async function refreshNodeDocument(): Promise<void> {
  try {
    currentNodeDocument = await getNodeDocument();
  } catch {
    currentNodeDocument = null;
  }

  refreshIdentityPane();
  refreshRelayStatusUi();
}

async function runLookup(rawQuery: string): Promise<void> {
  const query = normalizeLookupInput(rawQuery);
  if (query.length === 0) {
    setLookupState({ status: "idle" });
    return;
  }

  activeLookup?.abort();
  const controller = new AbortController();
  activeLookup = controller;
  setLookupState({ status: "loading", query });

  try {
    const identity = await lookupHandle(query, controller.signal);
    if (controller.signal.aborted) return;
    if (currentIdentityDocument !== null && identity.canonical_id === currentIdentityDocument.canonical_id) {
      // The directory exists to find other people; resolving your own
      // profile here only invites accidental self-actions.
      setLookupState({
        status: "error",
        query,
        message: "that's you — search someone else"
      });
      return;
    }
    const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(identity));
    const [relationship, subscription] = await loadLookupContext(identity.canonical_id);
    if (controller.signal.aborted) return;
    setLookupState({
      status: "resolved",
      query,
      identity,
      fingerprint,
      relationship: relationship ?? undefined,
      subscription
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    setLookupState({
      status: "error",
      query,
      message: error instanceof Error ? error.message : "lookup failed",
    });
  }
}

async function loadLookupContext(canonicalId: string): Promise<[ConnectionRelationship | null, FeedSubscription | null]> {
  if (currentIdentityDocument === null) {
    return [null, null];
  }

  const [relationship, subscriptions] = await Promise.all([
    getConnectionRelationship(currentIdentityDocument.canonical_id, canonicalId).catch(() => null),
    listFeedSubscriptions(currentIdentityDocument.canonical_id).catch(() => []),
  ]);

  return [relationship, subscriptions.find((subscription) => subscription.author_canonical_id === canonicalId) ?? null];
}

function setLookupState(nextState: LookupState): void {
  lookupState = nextState;
  if (nextState.status === "resolved") {
    currentLookupRelationship = nextState.relationship ?? null;
    currentLookupSubscription = nextState.subscription ?? null;
  } else {
    currentLookupRelationship = null;
    currentLookupSubscription = null;
  }
  renderLookupResult(lookupRoot, lookupState);
}

// Hard timeout for the entire signup/signin flow. If the orchestration takes
// longer than this, the user sees a clear "this is taking too long" error and
// the dialog button is reset, instead of staring at "creating account..."
// indefinitely. Per-step timeouts inside `withStep` are tighter than this.
const AUTH_FLOW_TIMEOUT_MS = 15000;
const AUTH_STEP_TIMEOUT_MS = 12000;

let signupBusy = false;
let signinBusy = false;

async function withStep<T>(label: string, work: () => Promise<T>, timeoutMs = AUTH_STEP_TIMEOUT_MS): Promise<T> {
  const start = performance.now();
  console.debug(`[auth] step start: ${label}`);
  let timer: number | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new AuthStepTimeout(label)), timeoutMs);
    });
    const result = await Promise.race([work(), timeout]);
    console.debug(`[auth] step ok: ${label} ${Math.round(performance.now() - start)}ms`);
    return result;
  } catch (error) {
    const elapsed = Math.round(performance.now() - start);
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[auth] step fail: ${label} ${elapsed}ms ${message}`);
    throw error instanceof AuthStepTimeout ? error : new AuthStepError(label, error);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

class AuthStepTimeout extends Error {
  constructor(public readonly label: string) {
    super(`step timeout: ${label}`);
    this.name = "AuthStepTimeout";
  }
}

class AuthStepError extends Error {
  constructor(public readonly label: string, public readonly cause: unknown) {
    const inner = cause instanceof Error ? cause.message : String(cause);
    super(inner);
    this.name = "AuthStepError";
  }
}

class AuthFlowTimeout extends Error {
  constructor() {
    super("flow timeout");
    this.name = "AuthFlowTimeout";
  }
}

async function withFlowTimeout<T>(work: () => Promise<T>): Promise<T> {
  let timer: number | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new AuthFlowTimeout()), AUTH_FLOW_TIMEOUT_MS);
    });
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

const LOCAL_DB_USER_MESSAGE = "this browser's local sudo data is locked or needs a refresh. close other sudo tabs and refresh.";

function describeAuthFailure(error: unknown): string {
  if (containsLocalDbError(error)) return LOCAL_DB_USER_MESSAGE;
  if (error instanceof AuthFlowTimeout) {
    return "this is taking too long. check your connection and try again.";
  }
  if (error instanceof AuthStepTimeout) {
    return `network slow or unreachable (${error.label}). try again.`;
  }
  if (error instanceof AuthStepError) {
    return error.message || `step failed: ${error.label}`;
  }
  if (error instanceof Error) return error.message;
  return "operation failed";
}

function containsLocalDbError(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 6 && cursor !== null && cursor !== undefined; depth++) {
    if (isLocalDatabaseError(cursor)) return true;
    if (cursor instanceof AuthStepError) { cursor = cursor.cause; continue; }
    if (cursor instanceof Error && (cursor as Error & { cause?: unknown }).cause !== undefined) {
      cursor = (cursor as Error & { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

async function runSignup(
  rawHandle: string,
  password: string,
  passwordConfirm: string,
  rawRecoveryAnswer: string
): Promise<void> {
  if (signupBusy) return;

  const handle = normalizeLookupInput(rawHandle);
  if (!/^[A-Za-z0-9_]{3,32}$/.test(handle)) {
    setSignupState({
      status: "error",
      message: "handles must be 3-32 chars: letters, numbers, underscore only",
    });
    return;
  }

  if (password !== passwordConfirm) {
    setSignupState({
      status: "error",
      message: "passphrases do not match",
    });
    return;
  }

  const passwordProblem = validatePassword(password);
  if (passwordProblem !== null) {
    setSignupState({
      status: "error",
      message: passwordProblem,
    });
    return;
  }

  signupBusy = true;
  setSignupState({ status: "loading" });

  // Park outside the auth flow timeout: waiting for the local DB is not a
  // network problem and shouldn't get killed by it. We retry indefinitely
  // here, never destructively. Server identity registration is gated on
  // the DB being writable so a hung browser cannot leave a partial
  // account on the network.
  try {
    await waitForLocalDbWritable((attempt) => {
      // Attempt 1 keeps the calm "creating account..." copy. Subsequent
      // attempts move into the explicit waiting state with an attempt
      // counter and the advanced-recovery disclosure.
      if (attempt > 1) setSignupState({ status: "waiting_for_local_data", attempt: attempt - 1 });
    });
  } catch (error) {
    setSignupState({ status: "error", message: describeAuthFailure(error) });
    signupBusy = false;
    return;
  }

  setSignupState({ status: "loading" });

  try {
    await withFlowTimeout(() => doSignup(handle, password));
  } catch (error) {
    setSignupState({ status: "error", message: describeAuthFailure(error) });
  } finally {
    signupBusy = false;
  }
}

// Client-signed session bootstrap. Used from both the signin path
// (after the local IndexedDB bundle has been unlocked with the
// passphrase) and the signup path (while the freshly-generated
// identity key is still in memory from createBrowserCryptoAccount).
// Fetches a single-use nonce, signs canonical_json of
// { type, canonical_id, nonce } with the local identity key, and
// exchanges the signature for a server session. The bearer is
// written to localStorage so the existing reload-restore path
// (readDevSessionToken → /api/identity/session) just works.
//
// Best-effort: any failure here logs a warning but does not throw.
// The local crypto bundle is the source of truth; if the network
// blip drops the bearer the next reload will require the user to
// re-enter their passphrase, but the account is not lost.
async function mintServerSessionFromUnlockedAccount(
  account: BrowserCryptoAccount,
  identity: IdentityDocument
): Promise<void> {
  try {
    const challenge = await fetchIdentityChallenge(identity.canonical_id);
    const signature = await signSessionChallenge(
      { type: "sudo_session_challenge", canonical_id: identity.canonical_id, nonce: challenge.nonce },
      account.identity_key,
      account.identity_key_type
    );
    const session = await exchangeChallengeForSession(identity.canonical_id, challenge.nonce, signature);
    await writeDevSessionToken(session.sessionToken);
  } catch (error) {
    console.warn("[auth] client-signed session bootstrap failed; UI continues but reload will require re-signin", error instanceof Error ? error.message : error);
  }
}

async function doSignup(handle: string, password: string): Promise<void> {

  const nodeDocument = await withStep(
    "node-document",
    () => currentNodeDocument !== null
      ? Promise.resolve(currentNodeDocument)
      : ensureNodeDocument().catch(() => null as NodeCapabilityDocument | null),
    8000
  );
  const draft = await withStep("crypto-account-create", () => createBrowserCryptoAccount({
    handle,
    passphrase: password,
    homeNode: window.location.origin,
    deliveryRelays: nodeDocument?.relay_capabilities ?? []
  }));
  const identity = await withStep("identity-register", () => registerIdentityDocument(draft.identity_document));
  const fingerprint = await withStep("fingerprint", () => fingerprintPublicKey(getIdentityPublicKey(identity)), 5000);
  // Mint a server session immediately at signup time using the same
  // client-signed challenge flow doSignin uses. Without this, reload
  // right after signup drops the user back to the menu because no
  // bearer was ever written. Best-effort: a transient failure logs
  // a warning but never tears down the local account — the crypto
  // bundle is already in IndexedDB and the user can sign in again.
  await withStep("mint-server-session", () => mintServerSessionFromUnlockedAccount(draft.account, identity));
  // Device metadata is local-only and must NEVER block signup. If the local
  // DB is slow/blocked we fall back to a fresh UUID and continue.
  const deviceId = await resolveDeviceIdNonBlocking();
  const trustedDevice = buildTrustedDeviceRecord(identity, draft.account, deviceId);
  await withStep("save-identity-seen", () => saveIdentitySeen({
    canonical_id: identity.canonical_id,
    document: identity,
    seen_at: new Date().toISOString()
  }));
  await withStep("store-crypto-account", () => storeBrowserCryptoAccount(draft.record));
  await withStep("save-trusted-device", () => saveTrustedDevice(trustedDevice).catch((error) => {
    // Don't block signup on local trusted-device write failure either; the
    // crypto account is the source of truth and is already stored above.
    console.warn("[auth] save-trusted-device failed", error instanceof Error ? error.message : error);
  }));
  currentCryptoAccount = draft.account;
  currentDeviceId = trustedDevice.device_id;
  setCurrentIdentity(identity, fingerprint);
  setSignupState({ status: "created", identity, fingerprint });
  signupDialog.close();
  setSignedIn(identity.handle);
  flashFeedback("account created");
  setFeedTab("personal");
  // Best-effort device sync; never blocks signup completion. We also
  // mint a self-signed SignedDeviceMembership so this device can act
  // as a sync origin (server requires an active membership for any
  // origin device).
  const selfMembership = await buildSelfSignedDeviceMembership(identity, draft.account, trustedDevice);
  void syncCurrentDeviceToServer(trustedDevice, selfMembership ?? undefined).catch((error) => {
    console.warn("[auth] device sync after signup failed", error instanceof Error ? error.message : error);
    devicePanelFeedback.textContent = "device sync delayed; account created";
  });
  setActiveCoordinator(draft.account, trustedDevice.device_id);
  startContactSyncPolling();
}

async function resolveDeviceIdNonBlocking(): Promise<string> {
  // Short, soft timeout: device metadata is purely a UX nicety. If anything
  // in the local DB stack stalls, generate a fresh device id and let the
  // background sync reconcile later.
  try {
    const metadata = await Promise.race<{ device_id: string } | null>([
      getLocalDeviceMetadata().catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500))
    ]);
    if (metadata?.device_id) return metadata.device_id;
  } catch {
    // ignore, fall through
  }
  return crypto.randomUUID();
}

function setSignupState(nextState: SignupState): void {
  signupState = nextState;
  renderSignupState(signupStateRoot, signupState);
  decorateAuthStateWithDbRecovery(signupStateRoot, nextState);
}

async function runSignin(rawHandle: string, password: string): Promise<void> {
  if (signinBusy) return;

  const handle = normalizeLookupInput(rawHandle);
  if (handle.length === 0 || password.length === 0) {
    setSigninState({ status: "error", message: "handle and passphrase are required" });
    return;
  }

  signinBusy = true;
  setSigninState({ status: "loading" });

  // Wait for local data to open before we ever say "wrong passphrase" or
  // "account not on this device". This loop is non-destructive: if the DB
  // is busy in another tab we ask it to release and retry indefinitely.
  try {
    await waitForLocalDbWritable((attempt) => {
      if (attempt > 1) setSigninState({ status: "waiting_for_local_data", attempt: attempt - 1 });
    });
  } catch (error) {
    setSigninState({ status: "error", message: describeAuthFailure(error) });
    signinBusy = false;
    return;
  }

  setSigninState({ status: "loading" });

  try {
    await withFlowTimeout(() => doSignin(handle, password));
  } catch (error) {
    setSigninState({ status: "error", message: describeAuthFailure(error) });
  } finally {
    signinBusy = false;
  }
}

async function doSignin(handle: string, password: string): Promise<void> {

  let localUnlockError: unknown = null;
  try {
    const account = await withStep(
      "unlock-local-account",
      () => unlockBrowserCryptoAccountByHandle(handle, password)
    );
    // Server existence check. Fires before any UI signed-in transition
    // so a positive 404 / canonical mismatch leaves the user on the
    // signin form with a clear stale-state error rather than half
    // signed-in against a server that doesn't know them. Called
    // outside withStep so StaleLocalAccountError survives untouched
    // (withStep wraps everything in AuthStepError, which would defeat
    // the instanceof check below). The verifier has its own 5s
    // timeout so we don't lose the timeout guarantee.
    await verifyServerKnowsAccount(account.identity_document.canonical_id, account.identity_document.handle);
    currentCryptoAccount = account;
    const fingerprint = await withStep("fingerprint", () => fingerprintPublicKey(getIdentityPublicKey(account.identity_document)), 5000);
    const identity = account.identity_document;
    await withStep("mint-server-session", () => mintServerSessionFromUnlockedAccount(account, identity));
    await withStep("save-identity-seen", () => saveIdentitySeen({
      canonical_id: identity.canonical_id,
      document: identity,
      seen_at: new Date().toISOString()
    }));
    currentDeviceId = await withStep("ensure-device-id", () => ensureCurrentDeviceId());
    await withStep("save-trusted-device", () => saveTrustedDevice(buildTrustedDeviceRecord(identity, account, currentDeviceId!)));
    setCurrentIdentity(identity, fingerprint);
    setSigninState({ status: "signed_in", identity });
    signinDialog.close();
    clearStaleAccountBanner();
    setSignedIn(identity.handle);
    // signed-in landing pane is the personal feed; tab state is reset by setFeedTab.
    void syncCurrentDeviceToServer(buildTrustedDeviceRecord(identity, account, currentDeviceId!)).catch((error) => {
      console.warn("[auth] device sync after signin failed", error instanceof Error ? error.message : error);
    });
    setActiveCoordinator(account, currentDeviceId!);
    startContactSyncPolling();
    return;
  } catch (error) {
    if (error instanceof StaleLocalAccountError) {
      // Definitive: do not fall back to dev signin. Drop any in-memory
      // unlocked material and surface the stale-state UI.
      lockBrowserCryptoAccount();
      currentCryptoAccount = null;
      showStaleAccountBanner(error.handle);
      throw error;
    }
    localUnlockError = error;
  }

  // Local-first unlock failed. Previously this branch fell through to
  // POST /api/identity/signin as a legacy fallback for accounts whose
  // password credential lived in dev_account_access. After migration
  // step 4 the production browser portal no longer needs that path:
  //   - browser-key accounts (the universal flow today) get their
  //     authoritative answer from unlockBrowserCryptoAccountByHandle
  //   - legacy accounts that need migration go through an explicit
  //     "restore from backup or trusted device" flow, not a silent
  //     password retry against the server
  // The legacy /api/identity/signin route stays mounted for one
  // release as a death-watch canary; HTTP-direct callers can still
  // probe it. The browser just stops asking.
  throw new Error(explainSigninFailure(localUnlockError));
}

// Maps the local-IDB unlock failure to user-visible copy. The
// legacy /api/identity/signin server fallback is gone (migration
// step 5), so this function is now a pure local-error-only
// classifier — there is no second opinion to consult.
function explainSigninFailure(localError: unknown): string {
  if (containsLocalDbError(localError)) {
    return LOCAL_DB_USER_MESSAGE;
  }
  const localMessage = localError instanceof Error ? localError.message : "";
  if (/stored account not found/i.test(localMessage)) {
    return "account not found on this device. restore or link this device.";
  }
  return "wrong passphrase, or this account is on another device.";
}

// runRecover (the legacy /api/identity/recover client) was removed
// in migration step 6 alongside the server route. Account recovery
// on a fresh device now happens entirely via importSelectedBackup
// using the user's encrypted .sudo-backup.json + passphrase.

async function submitRestoreAccount(): Promise<void> {
  const file = restoreFileInput.files?.[0];
  const passphrase = restorePassphraseInput.value.trim();
  if (file === undefined) {
    setRestoreState({ status: "error", message: "choose a backup file" });
    return;
  }
  if (passphrase.length === 0) {
    setRestoreState({ status: "error", message: "enter the backup passphrase" });
    return;
  }

  setRestoreState({ status: "loading" });
  try {
    await importSelectedBackup(file, passphrase);
    restoreDialog.close();
    flashFeedback("backup restored");
  } catch (error) {
    setRestoreState({
      status: "error",
      message: error instanceof Error ? error.message : "restore failed"
    });
  }
}

function setSigninState(nextState: SigninState): void {
  signinState = nextState;
  renderSigninState(signinStateRoot, signinState);
  decorateAuthStateWithDbRecovery(signinStateRoot, nextState);
}

// Append a calm, non-destructive recovery panel underneath the rendered
// auth state when we're waiting on the local database. Local-first data
// is treated as durable: the panel only offers "retry now" / "reload",
// and the destructive reset action is hidden behind an "advanced
// recovery" disclosure so it can never be the easy first answer.
function decorateAuthStateWithDbRecovery(
  root: HTMLElement,
  state: { status: string; message?: string; attempt?: number }
): void {
  const isWaiting = state.status === "waiting_for_local_data";
  if (!isWaiting) return;

  const panel = document.createElement("div");
  panel.className = "auth-recovery auth-recovery--waiting";

  if (typeof state.attempt === "number" && state.attempt > 1) {
    const hint = document.createElement("div");
    hint.className = "auth-recovery__hint";
    hint.textContent = `still opening local data (attempt ${state.attempt}). nothing on this device is being deleted.`;
    panel.append(hint);
  }

  const actions = document.createElement("div");
  actions.className = "auth-recovery__actions";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "text-button";
  retry.textContent = "retry now";
  retry.addEventListener("click", () => {
    // Same-account multi-tab usage is normal: don't ask peers to close.
    // Just retry our own open.
    resetCachedLocalDb();
    triggerLocalDbRetryNow();
  });

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "text-button";
  reload.textContent = "reload page";
  reload.addEventListener("click", () => window.location.reload());

  actions.append(retry, reload);
  panel.append(actions);

  // ---- advanced recovery (collapsed by default) ----
  // Reset is intentionally NOT a peer of "retry now". Users have to
  // open this disclosure on purpose before they can wipe local state,
  // matching the principle that local data is valuable.
  const advanced = document.createElement("details");
  advanced.className = "auth-recovery__advanced";
  const summary = document.createElement("summary");
  summary.textContent = "advanced recovery";
  advanced.append(summary);

  const advancedHint = document.createElement("div");
  advancedHint.className = "auth-recovery__hint";
  advancedHint.textContent = "if everything else fails, you can clear this browser's local sudo data. your server identity, feed posts, and backups are not deleted. use this only as a last resort.";
  advanced.append(advancedHint);

  const advancedActions = document.createElement("div");
  advancedActions.className = "auth-recovery__actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "text-button text-button--danger auth-recovery__reset";
  reset.textContent = "reset this device";
  reset.addEventListener("click", () => { void resetThisDeviceWithConfirm(); });
  advancedActions.append(reset);
  advanced.append(advancedActions);

  panel.append(advanced);
  root.append(panel);
}

// ---- DB retry coordination shared by signup + signin ----
// The retry loops park on a sleep that listens for an external "retry
// now" wake-up. The button installs the waker; clicking it pulls every
// active loop out of its current backoff immediately.
const localDbRetryWakers = new Set<() => void>();
function triggerLocalDbRetryNow(): void {
  for (const wake of [...localDbRetryWakers]) {
    try { wake(); } catch { /* ignore */ }
  }
}

async function waitWithRetryWaker(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      localDbRetryWakers.delete(finish);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    localDbRetryWakers.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

// Indefinitely retry the local-DB pre-flight. Reports each attempt via
// onAttempt so the UI can show the calm waiting state. Resolves only on
// success or when the signal aborts.
async function waitForLocalDbWritable(
  onAttempt: (attempt: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const delays = [0, 1000, 3000, 5000, 5000, 5000];
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new LocalDatabaseError("retry cancelled", "open_failed");
    attempt += 1;
    onAttempt(attempt);
    try {
      await probeLocalDbWritable(5000);
      return;
    } catch (error) {
      if (!isLocalDatabaseError(error)) throw error;
      // Ask peer tabs to release their connection before we sleep.
      // Don't broadcast release-db here. Sibling sudo tabs holding the
      // same account's DB are not the problem during normal use. Drop
      // our own cached open and let openLocalDb retry from scratch.
      resetCachedLocalDb();
      const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 5000;
      if (delay > 0) await waitWithRetryWaker(delay, signal);
    }
  }
}

// Thrown when the server registry no longer recognises a locally-stored
// account (server wipe, identity deletion, or handle re-claimed by
// someone else). Treated as definitive: do not fall back to other
// auth paths, because they will all fail the same way and produce a
// confusing error.
class StaleLocalAccountError extends Error {
  constructor(readonly handle: string, readonly reason: "not_found" | "canonical_mismatch") {
    super(reason === "not_found"
      ? `this account no longer exists on this node. if you have a backup file, restore it. otherwise the account is gone — sign up for a new one.`
      : `the handle @${handle} now belongs to a different account on this node.`);
  }
}

// Verify the server still knows the locally-unlocked identity. Throws
// StaleLocalAccountError on positive evidence (404 / canonical_id
// mismatch) and resolves silently on success or transient failure
// (network, 5xx) — we do not want to lock users out for a flaky
// connection. The only verification that fires is the public
// well-known handle lookup, which already exists.
async function verifyServerKnowsAccount(canonicalId: string, handle: string): Promise<void> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 5000);
  try {
    const document = await lookupHandle(handle, controller.signal);
    if (document.canonical_id !== canonicalId) {
      throw new StaleLocalAccountError(handle, "canonical_mismatch");
    }
  } catch (error) {
    if (error instanceof StaleLocalAccountError) throw error;
    if (error instanceof Error && /handle not found/i.test(error.message)) {
      throw new StaleLocalAccountError(handle, "not_found");
    }
    // Network / 5xx / abort: do not block the user.
    console.warn("[auth] server existence check inconclusive", error instanceof Error ? error.message : error);
  } finally {
    window.clearTimeout(timer);
  }
}

function showStaleAccountBanner(handle: string): void {
  if (landingStaleBanner === null) return;
  // Stored handles can carry a leading "@"; strip it before re-prefixing.
  // The wording is deliberately honest: with the password/recovery-answer
  // flows gone, an account that the server no longer knows can only be
  // brought back by an encrypted backup file the user kept. There is no
  // server-side recovery path. If they have no backup, the account is
  // permanently gone — say so plainly so they don't sit waiting for help
  // that isn't coming. The CTA opens the restore-from-file dialog
  // directly so users don't have to discover restore via the signin
  // flow. data-stale-action keeps it distinct from data-auth-action,
  // which the auth-lifecycle smoke asserts is absent on landing.
  const display = handle.replace(/^@+/, "");
  const message = document.createElement("div");
  message.className = "landing__stale-message";
  message.textContent = `@${display} is no longer on this node. if you exported an encrypted backup file, restore it to bring the account back. otherwise the account is gone — sign up for a new one or reset this browser.`;

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "text-button text-button--primary landing__stale-restore";
  cta.textContent = "restore from backup file";
  cta.dataset["staleAction"] = "restore";
  cta.addEventListener("click", () => openRestoreDialog());

  // Reset escape hatch for stale-state users with no backup. They can
  // never reach Settings (which requires being signed-in), so without
  // this link they would have no way to clear local data and start
  // fresh on this browser. Visually de-emphasized — small underline,
  // not a primary button — and still gated by window.confirm() inside
  // resetThisDeviceWithConfirm().
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "landing__stale-reset";
  reset.textContent = "reset this browser";
  reset.dataset["staleAction"] = "reset";
  reset.addEventListener("click", () => { void resetThisDeviceWithConfirm(); });

  landingStaleBanner.replaceChildren(message, cta, reset);
  landingStaleBanner.hidden = false;
}

function clearStaleAccountBanner(): void {
  if (landingStaleBanner === null) return;
  landingStaleBanner.textContent = "";
  landingStaleBanner.hidden = true;
}

async function resetThisDeviceWithConfirm(): Promise<void> {
  const confirmed = window.confirm(
    "Reset this browser's local sudo data? This removes accounts and messages stored only in this browser. " +
    "Your server identity and feed posts are not deleted. You can sign back in or restore from a backup afterwards."
  );
  if (!confirmed) return;
  try {
    await deleteLocalDb();
    flashFeedback("local sudo data cleared. reloading...");
  } catch (error) {
    const message = error instanceof Error ? error.message : "reset failed";
    flashFeedback(message);
    return;
  }
  // Force a clean reload regardless of in-flight fetches.
  window.setTimeout(() => window.location.reload(), 200);
}

async function restoreStoredSession(): Promise<void> {
  const sequence = ++authSequence;
  const token = await readDevSessionToken();
  if (token === null) {
    if (sequence === authSequence) setSignedOut();
    // Even with no live session, surface a stale-state hint when there
    // is locally-stored encrypted account material whose handle the
    // server no longer knows. Best-effort: a single round-trip per
    // page load, only if a stored account exists.
    void detectStaleStoredAccountsAndBanner();
    return;
  }

  try {
    const identity = await restoreDevSession(token);
    // Defense in depth: even if /api/identity/session returned a usable
    // identity, confirm the canonical_id is still in the public
    // registry. Catches the case where the dev_sessions row survived
    // a partial reset but the identities row did not.
    await verifyServerKnowsAccount(identity.canonical_id, identity.handle);
    const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(identity));
    await saveIdentitySeen({
      canonical_id: identity.canonical_id,
      document: identity,
      seen_at: new Date().toISOString()
    });
    if (sequence !== authSequence) return;
    setCurrentIdentity(identity, fingerprint);
    clearStaleAccountBanner();
    setSignedIn(identity.handle);
  } catch (error) {
    if (sequence !== authSequence) return;
    await clearDevSessionToken();
    setSignedOut();
    if (error instanceof StaleLocalAccountError) {
      showStaleAccountBanner(error.handle);
    } else {
      void detectStaleStoredAccountsAndBanner();
    }
  }
}

// Best-effort post-restore stale check: if the user has locally
// stored crypto_accounts and any of them now 404 against the public
// registry, show the stale banner so they understand why they were
// signed out. Silent on transient failures.
async function detectStaleStoredAccountsAndBanner(): Promise<void> {
  let stored: Awaited<ReturnType<typeof listCryptoAccounts>>;
  try {
    stored = await listCryptoAccounts();
  } catch {
    return;
  }
  for (const entry of stored) {
    try {
      await verifyServerKnowsAccount(entry.canonical_id, entry.handle);
    } catch (error) {
      if (error instanceof StaleLocalAccountError) {
        showStaleAccountBanner(error.handle);
        return;
      }
      // transient — skip this entry and try the next
    }
  }
}

async function refreshLocalStorageStatus(): Promise<void> {
  const status = await getLocalStorageStatus();
  // Plain language for what's on this device. Drop "events" (an
  // internal sync-log count that means nothing to a user) and avoid
  // the word "device status" which the prior copy led with.
  const pieces = [
    `${status.messages} message${status.messages === 1 ? "" : "s"}`,
    `${status.contacts} contact${status.contacts === 1 ? "" : "s"}`,
    `${status.trusted_devices} linked device${status.trusted_devices === 1 ? "" : "s"}`
  ];
  if (status.pending_outbound > 0) {
    pieces.push(`${status.pending_outbound} pending`);
  }
  localStateStatus.textContent = `this browser holds ${pieces.join(", ")}.`;
  void refreshDevicePanel();
}

async function refreshDevicePanel(): Promise<void> {
  const metadata = await getLocalDeviceMetadata().catch(() => null);
  if (currentDeviceId === null && metadata !== null) {
    currentDeviceId = metadata.device_id;
  }

  const localDevices = currentIdentityDocument === null
    ? []
    : await listTrustedDevices(currentIdentityDocument.canonical_id).catch(() => []);
  const serverDevices = currentIdentityDocument === null
    ? []
    : await listServerTrustedDevices(currentIdentityDocument.canonical_id).catch(() => []);

  const devicesById = new Map<string, import("./types.js").TrustedDevice>();
  for (const device of [...serverDevices, ...localDevices]) {
    devicesById.set(device.device_id, device);
  }

  if (currentIdentityDocument !== null && currentCryptoAccount !== null) {
    const currentDevice = buildTrustedDeviceRecord(
      currentIdentityDocument,
      currentCryptoAccount,
      currentDeviceId ?? metadata?.device_id ?? crypto.randomUUID()
    );
    devicesById.set(currentDevice.device_id, currentDevice);
    currentDeviceId = currentDevice.device_id;
  }

  const devices = [...devicesById.values()].sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at));
  deviceCurrentStatus.textContent = currentIdentityDocument === null
    ? "not signed in"
    : `signed in as ${currentIdentityDocument.handle}`;
  renderDevicePanel(deviceList, currentDeviceId, devices, activePairingCode);
}

async function syncCurrentDeviceToServer(
  device: import("./types.js").TrustedDevice,
  signedMembership?: import("./types.js").SignedDeviceMembership
): Promise<void> {
  if (currentIdentityDocument === null) return;

  try {
    await registerTrustedDevice(device, signedMembership);
    devicePanelFeedback.textContent = "device saved";
  } catch {
    devicePanelFeedback.textContent = "device saved locally";
  }
}

async function buildSelfSignedDeviceMembership(
  identity: import("./types.js").IdentityDocument,
  account: BrowserCryptoAccount,
  device: import("./types.js").TrustedDevice
): Promise<import("./types.js").SignedDeviceMembership | null> {
  try {
    const now = device.last_seen_at;
    const signable: import("./types.js").SignableDeviceMembership = {
      type: "sudo_device_membership",
      protocol_version: "0.1.0",
      owner_canonical_id: identity.canonical_id,
      device_id: device.device_id,
      device_public_key: device.device_public_key,
      device_key_type: account.identity_key_type,
      name: device.name,
      capabilities: device.capabilities,
      trust_state: device.trust_state,
      created_at: device.created_at,
      updated_at: now,
      sequence: 1
    };
    const signature = await signDeviceMembership(signable, account.identity_key, account.identity_key_type);
    return { ...signable, signature };
  } catch (error) {
    // Membership is required for sync but is best-effort to mint —
    // signup must still complete if anything in this path fails.
    console.warn("[sync] self-signed membership build failed", error instanceof Error ? error.message : error);
    return null;
  }
}

function buildTrustedDeviceRecord(
  identity: IdentityDocument,
  account: BrowserCryptoAccount,
  deviceId: string
): import("./types.js").TrustedDevice {
  return {
    type: "sudo_trusted_device",
    device_id: deviceId,
    owner_canonical_id: identity.canonical_id,
    name: "This device",
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    trust_state: "active",
    device_public_key: identity.keys.device?.public_key ?? identity.keys.identity.public_key,
    capabilities: {
      can_sync: true,
      can_decrypt: true
    }
  };
}

async function ensureCurrentDeviceId(): Promise<string> {
  if (currentDeviceId !== null) return currentDeviceId;
  const deviceId = await resolveDeviceIdNonBlocking();
  currentDeviceId = deviceId;
  return deviceId;
}

async function unlockBrowserCryptoAccountByHandle(handle: string, passphrase: string): Promise<BrowserCryptoAccount> {
  const accounts = await listCryptoAccounts();
  const selected = accounts.find((account) => account.canonical_id === handle || account.handle === handle || account.handle === `@${handle}`);
  if (selected === undefined) {
    throw new Error("stored account not found");
  }

  return unlockBrowserCryptoAccount(selected.canonical_id, passphrase);
}

// Existing-device side of link-existing-account. Generates a pairing
// code, posts the user's encrypted account bundle into the pairing
// channel (wrapped with PBKDF2(pairing_code) so the server only ever
// sees opaque ciphertext), and renders the visible pairing card with
// code, URL, expiry countdown, and cancel.
async function startPairingFlow(): Promise<void> {
  if (currentIdentityDocument === null || currentCryptoAccount === null) {
    devicePanelFeedback.textContent = "unlock your account first";
    return;
  }
  // Pull the current crypto_account record (the one already stored
  // in IndexedDB) so we can hand its encrypted_bundle_json to the
  // pairing channel. The bundle is already encrypted under the
  // user's account passphrase; we wrap it once more under the
  // pairing code for transit.
  let record;
  try {
    const accounts = await listCryptoAccounts();
    record = accounts.find((account) => account.canonical_id === currentIdentityDocument!.canonical_id);
  } catch {
    record = undefined;
  }
  if (!record) {
    devicePanelFeedback.textContent = "could not read local account; reload and try again";
    return;
  }

  let started;
  try {
    started = await startDevicePairing(currentIdentityDocument.canonical_id);
  } catch (error) {
    devicePanelFeedback.textContent = error instanceof Error ? error.message : "pairing start failed";
    return;
  }

  // Encrypt the inner (passphrase-encrypted) bundle once more with
  // PBKDF2(pairing_code) so even an attacker who guesses the
  // pairing code still has to crack the user's passphrase.
  let outerCiphertext;
  try {
    outerCiphertext = await wrapBundleWithPairingCode(record.encrypted_bundle_json, started.pairing_code);
  } catch (error) {
    devicePanelFeedback.textContent = error instanceof Error ? error.message : "could not prepare bundle";
    return;
  }

  try {
    await postPairHandoffBundle(started.pairing_code, outerCiphertext);
  } catch (error) {
    devicePanelFeedback.textContent = error instanceof Error ? error.message : "could not deposit bundle";
    return;
  }

  activePairingCode = started.pairing_code;
  activePairingToken = started.pairing_token;
  activePairingExpiresAt = started.expires_at;
  renderPairingCard();
  devicePanelFeedback.textContent = "";
  await refreshDevicePanel();
}

function renderPairingCard(): void {
  if (activePairingCode === null) {
    pairingCard.hidden = true;
    pairingCardCode.textContent = "";
    pairingCardUrl.textContent = "";
    pairingCardExpires.textContent = "";
    pairingCardQr.replaceChildren();
    pairingCardSuccess.hidden = true;
    if (pairingExpiresInterval !== null) {
      window.clearInterval(pairingExpiresInterval);
      pairingExpiresInterval = null;
    }
    return;
  }
  pairingCard.hidden = false;
  pairingCardSuccess.hidden = true;
  pairingCardCode.textContent = activePairingCode;
  // ?collect= is the canonical URL parameter for the new
  // collect-account flow. ?pair= stayed as a legacy alias on the
  // server side so older QR codes still work.
  const url = `${window.location.origin}/?collect=${encodeURIComponent(activePairingCode)}`;
  pairingCardUrl.textContent = url;

  // Render a real QR code as inline SVG. The encoder is hardcoded
  // to QR version 3 / EC level L which holds 53 bytes — enough for
  // our short collect URL. If encoding fails (data too long, etc.)
  // we hide the QR slot rather than throw — the typed code stays.
  try {
    pairingCardQr.innerHTML = encodeUrlToQrSvg(url, 6, 4);
  } catch {
    pairingCardQr.replaceChildren();
  }

  const tickExpiry = () => {
    if (activePairingExpiresAt === null) return;
    const ms = Date.parse(activePairingExpiresAt) - Date.now();
    if (ms <= 0) {
      pairingCardExpires.textContent = "code expired. generate a new one.";
      void cancelActivePairing({ silent: true });
      return;
    }
    const seconds = Math.ceil(ms / 1000);
    pairingCardExpires.textContent = `expires in ${seconds}s`;
  };
  tickExpiry();
  if (pairingExpiresInterval !== null) window.clearInterval(pairingExpiresInterval);
  pairingExpiresInterval = window.setInterval(tickExpiry, 1000);

  // Background poll: when a new device shows up in our trusted-
  // devices list (matching this owner, not equal to currentDeviceId),
  // surface "device linked" and tear down the card after a beat.
  // Polling the server is cheap and the card is short-lived (60s).
  startPairingCompletionPoll();
}

let pairingCompletionPoll: number | null = null;
let pairingBaselineDeviceIds: Set<string> | null = null;
function startPairingCompletionPoll(): void {
  stopPairingCompletionPoll();
  if (currentIdentityDocument === null) return;
  const owner = currentIdentityDocument.canonical_id;
  const initial = async () => {
    try {
      const devices = await listServerTrustedDevices(owner);
      pairingBaselineDeviceIds = new Set(devices.filter((d) => d.trust_state === "active").map((d) => d.device_id));
    } catch {
      pairingBaselineDeviceIds = new Set();
    }
  };
  void initial();
  pairingCompletionPoll = window.setInterval(async () => {
    if (activePairingCode === null) {
      stopPairingCompletionPoll();
      return;
    }
    try {
      const devices = await listServerTrustedDevices(owner);
      const fresh = devices.filter((d) => d.trust_state === "active" && d.device_id !== currentDeviceId);
      const baseline = pairingBaselineDeviceIds ?? new Set();
      const newDevice = fresh.find((d) => !baseline.has(d.device_id));
      if (newDevice !== undefined) {
        // A new device just paired with us. Clear the active
        // passcode (so the timer/cancel UI tear down) and surface a
        // "syncing account data…" line inside the card while we
        // republish current local state as sync events. The new
        // device's polling coordinator picks them up; without this
        // backfill it would start empty and only receive future
        // writes.
        activePairingCode = null;
        activePairingToken = null;
        activePairingExpiresAt = null;
        pairingCardSuccess.hidden = false;
        pairingCardSuccess.textContent = `syncing account data to ${newDevice.name || newDevice.device_id.slice(0, 8)}…`;
        pairingCardQr.replaceChildren();
        pairingCardCode.textContent = "";
        pairingCardUrl.textContent = "";
        pairingCardExpires.textContent = "";
        if (pairingExpiresInterval !== null) {
          window.clearInterval(pairingExpiresInterval);
          pairingExpiresInterval = null;
        }
        stopPairingCompletionPoll();
        await refreshDevicePanel();
        // Refresh the menu indicator immediately so the user sees
        // their recovery posture flip from "unprotected" to
        // "✓ linked device".
        void refreshAccountMenuRecoveryIndicator();

        // Run the backfill out-of-band so the user can keep using
        // the app. Pass the new device's id so the run gets
        // recorded against the right row in backfill_state; partial
        // runs are retried on next signin.
        void backfillToNewDevice(owner, newDevice.device_id)
          .then((result) => {
            pairingCardSuccess.textContent = result.partial
              ? "device linked. sync will retry on next signin."
              : `device linked${result.totalEvents > 0 ? ` (synced ${result.totalEvents} item${result.totalEvents === 1 ? "" : "s"})` : ""}`;
            window.setTimeout(() => {
              if (activePairingCode === null) renderPairingCard();
            }, 3500);
          })
          .catch((error) => {
            console.warn("[devices] backfill error", error instanceof Error ? error.message : error);
            pairingCardSuccess.textContent = "device linked. some local data may sync later.";
            window.setTimeout(() => {
              if (activePairingCode === null) renderPairingCard();
            }, 3500);
          });
      }
    } catch { /* network blip — try again next tick */ }
  }, 2000);
}

function stopPairingCompletionPoll(): void {
  if (pairingCompletionPoll !== null) {
    window.clearInterval(pairingCompletionPoll);
    pairingCompletionPoll = null;
  }
  pairingBaselineDeviceIds = null;
}

// After a fresh device pairs, the new install starts with an empty
// local store. Polling the trusted-device sync log only catches
// FUTURE writes — pre-existing contacts/subscriptions/messages
// would never appear unless the user happened to write again.
// backfillToNewDevice replays the existing local state through the
// already-active sync coordinator (encrypted under the same
// account_sync_sym_key the new device just received in its bundle)
// so the new device's coordinator picks them up on its next poll
// cycle.
//
// Backoff schedule for retrying a failed/partial backfill on a
// subsequent signin. Index by `attempts - 1`; past index 2 the
// cap stays at 10 minutes. The caller checks
// `last_attempt_at + RETRY_BACKOFF_MS[Math.min(attempts-1, 2)] <= now`
// before re-running so a fast successful signin shortly after a
// partial run doesn't immediately re-fire.
const RETRY_BACKOFF_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
const MAX_BACKFILL_ATTEMPTS = 5;

// Iterate the owner's local state and publish each row as an
// encrypted sync event. The target_device_id is recorded against
// the row in `backfill_state` so a partial run (network blip, rate
// limit) can be retried on the next signin. Returns a summary so
// callers can update UI.
async function backfillToNewDevice(
  ownerCanonicalId: string,
  targetDeviceId: string
): Promise<{ totalEvents: number; partial: boolean }> {
  let totalEvents = 0;
  let partial = false;
  const sliceProgress: { [slice: string]: number } = {};
  const existing = await getBackfillState(ownerCanonicalId, targetDeviceId).catch(() => null);
  const attempts = (existing?.attempts ?? 0) + 1;

  await putBackfillState({
    owner_canonical_id: ownerCanonicalId,
    target_device_id: targetDeviceId,
    status: "running",
    attempts,
    last_attempt_at: new Date().toISOString(),
    slice_progress: existing?.slice_progress
  });

  let lastError = "";

  // Contacts.
  try {
    const contacts = await listLocalContacts(ownerCanonicalId);
    let count = 0;
    let failed = 0;
    for (const contact of contacts) {
      const ok = await buildAndPostSyncEvent("contact", "contact.upsert", {
        canonical_id: contact.canonical_id,
        handle: contact.handle,
        tier: contact.tier,
        added_at: contact.added_at,
        updated_at: contact.updated_at,
        fingerprint: contact.fingerprint
      });
      if (ok) count++; else failed++;
    }
    sliceProgress.contact = count;
    totalEvents += count;
    if (failed > 0) {
      partial = true;
      lastError = `contacts: ${failed} of ${contacts.length} failed to post`;
    }
  } catch (error) {
    console.warn("[backfill] contacts failed", error instanceof Error ? error.message : error);
    partial = true;
    lastError = `contacts: ${error instanceof Error ? error.message : "unknown"}`;
  }

  // Subscriptions.
  try {
    const subs = await listLocalSubscriptions(ownerCanonicalId);
    let count = 0;
    let failed = 0;
    for (const sub of subs) {
      const ok = await buildAndPostSyncEvent("subscription", "subscription.upsert", {
        author_canonical_id: sub.author_canonical_id,
        include_public: sub.include_public,
        include_connections: sub.include_connections,
        include_close: sub.include_close,
        updated_at: sub.updated_at
      });
      if (ok) count++; else failed++;
    }
    sliceProgress.subscription = count;
    totalEvents += count;
    if (failed > 0) {
      partial = true;
      lastError = `subscriptions: ${failed} of ${subs.length} failed to post`;
    }
  } catch (error) {
    console.warn("[backfill] subscriptions failed", error instanceof Error ? error.message : error);
    partial = true;
    lastError = `subscriptions: ${error instanceof Error ? error.message : "unknown"}`;
  }

  // Messages.
  try {
    const messages = await listLocalMessages(ownerCanonicalId);
    let count = 0;
    let failed = 0;
    for (const msg of messages) {
      const ok = await notifyMessageUpsert(ownerCanonicalId, msg);
      if (ok) count++; else failed++;
    }
    sliceProgress.message = count;
    totalEvents += count;
    if (failed > 0) {
      partial = true;
      lastError = `messages: ${failed} of ${messages.length} failed to post`;
    }
  } catch (error) {
    console.warn("[backfill] messages failed", error instanceof Error ? error.message : error);
    partial = true;
    lastError = `messages: ${error instanceof Error ? error.message : "unknown"}`;
  }

  // Drafts (new slice).
  try {
    const drafts = await listLocalDrafts(ownerCanonicalId);
    let count = 0;
    let failed = 0;
    for (const draft of drafts) {
      const ok = await buildAndPostSyncEvent("draft", "draft.upsert", {
        draft_id: draft.draft_id,
        conversation_id: draft.conversation_id,
        body: draft.body,
        updated_at: draft.updated_at
      });
      if (ok) count++; else failed++;
    }
    sliceProgress.draft = count;
    totalEvents += count;
    if (failed > 0) {
      partial = true;
      lastError = `drafts: ${failed} of ${drafts.length} failed to post`;
    }
  } catch (error) {
    console.warn("[backfill] drafts failed", error instanceof Error ? error.message : error);
    partial = true;
    lastError = `drafts: ${error instanceof Error ? error.message : "unknown"}`;
  }

  // Profile (bio + last_backup_at). One event captures the full
  // current account-profile snapshot.
  try {
    const bio = await getSetting(profileBioKey(ownerCanonicalId));
    const lastBackup = await getSetting(profileLastBackupKey(ownerCanonicalId));
    const payload: { bio?: string; last_backup_at?: string } = {};
    if (typeof bio === "string") payload.bio = bio;
    if (typeof lastBackup === "string") payload.last_backup_at = lastBackup;
    if (Object.keys(payload).length > 0) {
      const ok = await buildAndPostSyncEvent("profile", "profile.upsert", payload);
      sliceProgress.profile = ok ? 1 : 0;
      if (ok) totalEvents += 1;
      else { partial = true; lastError = "profile: post failed"; }
    } else {
      sliceProgress.profile = 0;
    }
  } catch (error) {
    console.warn("[backfill] profile failed", error instanceof Error ? error.message : error);
    partial = true;
    lastError = `profile: ${error instanceof Error ? error.message : "unknown"}`;
  }

  await putBackfillState({
    owner_canonical_id: ownerCanonicalId,
    target_device_id: targetDeviceId,
    status: partial ? "pending" : "complete",
    attempts,
    last_attempt_at: new Date().toISOString(),
    last_error: partial ? lastError : undefined,
    total_events: totalEvents,
    slice_progress: sliceProgress
  });

  return { totalEvents, partial };
}

// Re-run backfills that were left pending or failed by a previous
// session. Called from setSignedIn so a partial run from an earlier
// browser open resumes the moment the user signs in again, without
// requiring them to re-pair the device.
async function retryPendingBackfills(ownerCanonicalId: string): Promise<void> {
  let pending: import("./local/local-types.js").LocalBackfillState[];
  try {
    pending = await listPendingBackfills(ownerCanonicalId);
  } catch { return; }
  if (pending.length === 0) return;
  const now = Date.now();
  for (const row of pending) {
    if (row.attempts >= MAX_BACKFILL_ATTEMPTS) continue;
    const backoff = RETRY_BACKOFF_MS[Math.min(row.attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
    const earliestNextAt = Date.parse(row.last_attempt_at) + backoff;
    if (now < earliestNextAt) continue;
    // Don't block other retries on this one; each runs sequentially
    // anyway because they share the same coordinator state.
    await backfillToNewDevice(ownerCanonicalId, row.target_device_id).catch((error) => {
      console.warn(`[backfill] retry for ${row.target_device_id.slice(0, 8)} failed`, error instanceof Error ? error.message : error);
    });
  }
}

async function cancelActivePairing(options: { silent?: boolean } = {}): Promise<void> {
  const token = activePairingToken;
  activePairingCode = null;
  activePairingToken = null;
  activePairingExpiresAt = null;
  stopPairingCompletionPoll();
  renderPairingCard();
  if (token !== null) {
    await cancelPairing(token);
  }
  if (!options.silent) devicePanelFeedback.textContent = "passcode cancelled";
  await refreshDevicePanel();
}

// New-device side. The user opens "link existing account" on the
// landing screen, types the pairing code from their original device,
// and enters the same passphrase that protects their crypto account.
// We fetch the bundle, peel the outer (pairing-code) layer, store
// the inner (passphrase-encrypted) bundle into IndexedDB, then run
// the same unlock + challenge-flow signin path as a normal "unlock
// this device". On success we sign a fresh SignedDeviceMembership
// for THIS device's brand-new device id and complete the pairing on
// the server so the original device's linked-devices list shows us.
async function runLinkExistingAccount(): Promise<void> {
  const pairingCode = linkDeviceCode.value.trim().toUpperCase();
  const passphrase = linkDevicePassphrase.value;
  if (pairingCode.length === 0 || passphrase.length === 0) {
    linkDeviceState.textContent = "enter the temporary passcode and your account passphrase";
    return;
  }

  linkDeviceState.textContent = "fetching encrypted account…";
  let handoff;
  try {
    handoff = await fetchPairHandoffBundle(pairingCode);
  } catch (error) {
    linkDeviceState.textContent = error instanceof Error ? error.message : "fetch failed";
    return;
  }
  if (handoff === null) {
    linkDeviceState.textContent = "this code expired or was already used. generate a new one on your other device.";
    return;
  }

  // Echo the resolved owner so the user can sanity-check before
  // committing to the local store.
  if (handoff.owner_handle) linkDeviceOwner.textContent = `linking ${handoff.owner_handle}`;

  // Peel the outer (pairing-code) layer.
  let innerEncryptedBundleJson: string;
  try {
    innerEncryptedBundleJson = await unwrapBundleWithPairingCode(handoff.encrypted_account_bundle, pairingCode);
  } catch {
    linkDeviceState.textContent = "could not decrypt the pairing payload (wrong code?)";
    return;
  }

  // Fetch the signed identity document so the LocalCryptoAccountRecord
  // carries the same identity_document_json a fresh signup would.
  let identityDocument;
  try {
    identityDocument = await fetchIdentityProfile(handoff.owner_canonical_id);
  } catch (error) {
    linkDeviceState.textContent = error instanceof Error ? error.message : "could not fetch identity profile";
    return;
  }

  // Verify the bundle decrypts with the passphrase BEFORE persisting
  // so a wrong passphrase doesn't leave a broken record on this
  // device. We do this by storing then attempting to unlock; on
  // failure we delete what we wrote.
  const now = new Date().toISOString();
  const homeNode = identityDocument.home_node ?? window.location.origin;
  const handle = identityDocument.handle;
  const record = {
    canonical_id: identityDocument.canonical_id,
    handle,
    home_node: homeNode,
    identity_document_json: JSON.stringify(identityDocument),
    encrypted_bundle_json: innerEncryptedBundleJson,
    created_at: now,
    updated_at: now
  };
  await storeBrowserCryptoAccount(record);
  linkDeviceState.textContent = "verifying passphrase…";
  let account;
  try {
    account = await unlockBrowserCryptoAccountByHandle(handle, passphrase);
  } catch (error) {
    // Wipe the half-written record so the user doesn't end up with a
    // stuck account row that will never unlock with the passphrase
    // they remember.
    try {
      await deleteCryptoAccount(identityDocument.canonical_id);
    } catch { /* ignore cleanup failure */ }
    // Bad-passphrase from AES-GCM throws an OperationError with an
    // empty message, so falling back on error.message would surface
    // nothing useful. Treat any unlock failure as a passphrase
    // problem unless it's a known specific error code.
    const message = error instanceof Error ? error.message : "";
    if (/stored account not found/i.test(message)) {
      linkDeviceState.textContent = "linking failed: account record went missing on this device";
    } else {
      linkDeviceState.textContent = "wrong passphrase. enter the same passphrase your other device uses.";
    }
    return;
  }

  // Mint a server session via the challenge flow so the new device
  // is properly signed in. mintServerSessionFromUnlockedAccount
  // reuses the same path normal signin uses; it handles writing the
  // bearer token to localStorage.
  linkDeviceState.textContent = "minting session…";
  try {
    await mintServerSessionFromUnlockedAccount(account, identityDocument);
  } catch (error) {
    linkDeviceState.textContent = error instanceof Error ? error.message : "session mint failed";
    return;
  }

  // Generate a fresh device id for THIS browser, sign a
  // SignedDeviceMembership with the just-unlocked identity key, and
  // complete the pairing on the server. The original device's linked-
  // devices dialog now sees us; we now have an active device id we
  // can use for trusted-device sync.
  const deviceId = await ensureCurrentDeviceId();
  const trustedDevice = buildTrustedDeviceRecord(identityDocument, account, deviceId);
  const membership = await buildSelfSignedDeviceMembership(identityDocument, account, trustedDevice);
  const bootstrap = await createEncryptedBootstrapPayload(trustedDevice, pairingCode);
  try {
    await completeDevicePairing({
      pairing_code: pairingCode,
      device_id: trustedDevice.device_id,
      name: trustedDevice.name,
      device_public_key: trustedDevice.device_public_key,
      encrypted_bootstrap_payload: bootstrap,
      ...(membership ? { signed_membership: membership } : {})
    });
  } catch (error) {
    linkDeviceState.textContent = error instanceof Error ? error.message : "pair complete failed";
    return;
  }

  await saveTrustedDevice(trustedDevice);
  // Best-effort: register on server (the existing post-signin path
  // also does this; failure here doesn't block sign-in).
  try { await registerTrustedDevice(trustedDevice); } catch { /* ignore */ }

  currentCryptoAccount = account;
  currentDeviceId = deviceId;
  const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(identityDocument));
  setCurrentIdentity(identityDocument, fingerprint);
  setSigninState({ status: "signed_in", identity: identityDocument });
  setSignedIn(handle);
  setActiveCoordinator(account, deviceId);
  startContactSyncPolling();

  linkDeviceState.textContent = "";
  linkDeviceCode.value = "";
  linkDevicePassphrase.value = "";
  linkDeviceOwner.textContent = "";
  linkDeviceDialog.close();
  // The original device kicks off a backfill of contacts /
  // subscriptions / messages right after pair/complete; the new
  // coordinator polls every few seconds and projects them as they
  // arrive. We fire a "syncing initial state…" toast immediately,
  // then "synced" after a short window so the user sees progress
  // even if no events are queued.
  flashFeedback("device linked. syncing initial state…");
  window.setTimeout(() => flashFeedback("synced"), 6000);
}

// PBKDF2(pairing_code) + AES-GCM wrapper around the (already
// passphrase-encrypted) crypto_account bundle JSON. Mirrors the
// envelope shape of createEncryptedBootstrapPayload so the new
// device can decrypt with the same KDF parameters.
async function wrapBundleWithPairingCode(innerJson: string, pairingCode: string): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveBackupKey(pairingCode, salt, 120000);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    new TextEncoder().encode(innerJson)
  );
  return JSON.stringify({
    salt: base64Url(salt),
    iv: base64Url(iv),
    ciphertext: base64Url(ciphertext)
  });
}

async function unwrapBundleWithPairingCode(envelopeJson: string, pairingCode: string): Promise<string> {
  const envelope = JSON.parse(envelopeJson) as { salt: string; iv: string; ciphertext: string };
  const salt = base64UrlToBytes(envelope.salt);
  const iv = base64UrlToBytes(envelope.iv);
  const ciphertext = base64UrlToBytes(envelope.ciphertext);
  const key = await deriveBackupKey(pairingCode, salt, 120000);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    toBufferSource(ciphertext)
  );
  return new TextDecoder().decode(plaintext);
}

function openLinkDeviceDialog(prefilledCode?: string): void {
  if (signupDialog.open) signupDialog.close();
  if (signinDialog.open) signinDialog.close();
  if (restoreDialog.open) restoreDialog.close();
  linkDeviceCode.value = prefilledCode ? prefilledCode.toUpperCase() : "";
  linkDevicePassphrase.value = "";
  linkDeviceState.textContent = "";
  linkDeviceOwner.textContent = "";
  if (!linkDeviceDialog.open) linkDeviceDialog.showModal();
  if (prefilledCode && prefilledCode.length > 0) linkDevicePassphrase.focus();
  else linkDeviceCode.focus();
}

async function revokeDevice(deviceId: string): Promise<void> {
  if (currentIdentityDocument === null) {
    return;
  }
  // Hard revoke. Without a signed_membership, the server only flips
  // the trusted_devices cache the UI reads — sync gating still
  // honors the device's current "active" SignedDeviceMembership and
  // the revoked device can keep pulling /sync. To actually block
  // sync, mint and POST a new signed membership with
  // trust_state="revoked" and sequence strictly greater than the
  // previous one. resolveActiveMembership on the server then
  // returns null and /sync GETs return 403.
  if (currentCryptoAccount === null) {
    devicePanelFeedback.textContent = "unlock your account first";
    return;
  }

  let signedMembership: import("./types.js").SignedDeviceMembership | undefined;
  try {
    signedMembership = await buildRevocationMembership(deviceId);
  } catch (error) {
    // Fall through to soft revoke if signing fails — the cache
    // flip is still valuable for the UI even if hard revoke
    // doesn't land. Surface the failure though, so an operator can
    // see why sync gating didn't tighten.
    console.warn("[devices] signed revocation membership build failed", error instanceof Error ? error.message : error);
  }

  try {
    const device = await revokeServerTrustedDevice(currentIdentityDocument.canonical_id, deviceId, signedMembership);
    await revokeTrustedDevice(device.device_id);
    devicePanelFeedback.textContent = signedMembership !== undefined ? "device revoked" : "device revoked (sync gate may lag)";
    await refreshDevicePanel();
    void refreshAccountMenuRecoveryIndicator();
  } catch (error) {
    devicePanelFeedback.textContent = error instanceof Error ? error.message : "device revoke failed";
  }
}

async function buildRevocationMembership(targetDeviceId: string): Promise<import("./types.js").SignedDeviceMembership> {
  if (currentIdentityDocument === null || currentCryptoAccount === null) {
    throw new Error("not signed in");
  }
  const owner = currentIdentityDocument.canonical_id;
  // Find the target device's current row + latest membership
  // sequence so we can mint a successor with sequence + 1.
  const [memberships, devices] = await Promise.all([
    listServerDeviceMemberships(owner).catch(() => []),
    listServerTrustedDevices(owner).catch(() => [])
  ]);
  const targetDevice = devices.find((d) => d.device_id === targetDeviceId);
  if (targetDevice === undefined) throw new Error("target device not in registry");
  const targetMemberships = memberships.filter((m) => m.device_id === targetDeviceId);
  const latestSequence = targetMemberships.reduce((max, m) => Math.max(max, m.sequence), 0);
  const now = new Date().toISOString();
  const signable: import("./types.js").SignableDeviceMembership = {
    type: "sudo_device_membership",
    protocol_version: "0.1.0",
    owner_canonical_id: owner,
    device_id: targetDevice.device_id,
    device_public_key: targetDevice.device_public_key,
    device_key_type: currentCryptoAccount.identity_key_type,
    name: targetDevice.name,
    capabilities: targetDevice.capabilities,
    trust_state: "revoked",
    created_at: targetDevice.created_at,
    updated_at: now,
    sequence: latestSequence + 1
  };
  const signature = await signDeviceMembership(signable, currentCryptoAccount.identity_key, currentCryptoAccount.identity_key_type);
  return { ...signable, signature };
}

async function createEncryptedBootstrapPayload(
  device: import("./types.js").TrustedDevice,
  pairingCode: string
): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveBackupKey(pairingCode, salt, 120000);
  const payload = {
    device_id: device.device_id,
    owner_canonical_id: device.owner_canonical_id,
    name: device.name,
    created_at: device.created_at,
    last_seen_at: device.last_seen_at
  };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toBufferSource(iv) },
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return JSON.stringify({
    salt: base64Url(salt),
    iv: base64Url(iv),
    ciphertext: base64Url(ciphertext)
  });
}

// Single source of truth for rebuilding the signed-in user's feed
// from current connection/subscription state. Every code path that
// changes "who's in B's network" must call this so the personal feed
// reflects the change without a page reload.
const refreshPersonalFeed = (): Promise<void> => refreshFeedPosts();

// activeThreadPostId, when non-null, means the center column is in
// focused-thread mode for that post. Feed refreshes during this mode
// no-op; exit returns to the normal feed.
let activeThreadPostId: string | null = null;
// When the user navigates from a reply notification we pin the new
// reply at the top of the comments panel and add a brief highlight.
// Stored alongside activeThreadPostId so the polling re-render
// (refreshFeedPosts → renderThreadView) preserves focus until the
// user navigates away.
let focusedCommentId: string | null = null;
// One-shot: triggers scrollIntoView + flash on the *first* render
// after enterThreadView. Subsequent re-renders driven by the live
// poll cycle do not re-scroll or re-flash, so the animation doesn't
// loop and the user doesn't get yanked back to the pin every few
// seconds while reading further down.
let focusedCommentScrollPending = false;

async function enterThreadView(postId: string, focusedReplyId?: string): Promise<void> {
  activeThreadPostId = postId;
  focusedCommentId = typeof focusedReplyId === "string" && focusedReplyId.length > 0
    ? focusedReplyId
    : null;
  focusedCommentScrollPending = focusedCommentId !== null;
  // Hide the composer while in thread view — the focused view has
  // its own reply composer for the parent post.
  const composer = document.getElementById("feed-composer");
  if (composer !== null) composer.hidden = true;
  await renderThreadView(postId);
}

function exitThreadView(): void {
  activeThreadPostId = null;
  focusedCommentId = null;
  focusedCommentScrollPending = false;
  const composer = document.getElementById("feed-composer");
  if (composer !== null) composer.hidden = false;
  void refreshFeedPosts();
}

async function renderThreadView(postId: string): Promise<void> {
  if (currentIdentityDocument === null) {
    streamRoot.replaceChildren();
    return;
  }
  // Build the focused container: back button + parent post + threaded
  // replies + reply composer. The parent post reuses the stream-post
  // shape so action buttons (vote/repost/reply) keep working.
  const container = document.createElement("div");
  container.className = "thread-view";
  container.dataset["threadView"] = postId;

  const back = document.createElement("button");
  back.type = "button";
  back.className = "thread-view__back";
  back.dataset["threadAction"] = "back";
  back.textContent = "← back";
  container.append(back);

  const parentSlot = document.createElement("div");
  parentSlot.className = "thread-view__parent";
  parentSlot.textContent = "loading post...";
  container.append(parentSlot);

  streamRoot.replaceChildren(container);

  try {
    const thread = await getFeedThread(postId, currentIdentityDocument.canonical_id);
    if (thread === null) {
      parentSlot.textContent = "post unavailable";
      return;
    }
    const item = feedPostToUnifiedItemFromEngagement(
      thread.post,
      thread.engagement[thread.post.post_id]
    );
    const parentArticle = renderThreadParentArticle(item);
    parentSlot.replaceChildren();
    parentSlot.append(parentArticle);

    // Open the replies panel inline with composer + threaded list.
    const panel = parentArticle.querySelector<HTMLElement>(
      `[data-replies-panel="${cssEscape(postId)}"]`
    );
    if (panel !== null) {
      // Thread payload already includes replies — pass them straight
      // through so the panel doesn't re-fetch from the server. The
      // focused-comment hint pins the relevant reply at the top of
      // the panel so the user lands on it immediately.
      openReplyComposer(postId, panel, thread.replies, focusedCommentId ?? undefined);
    }
  } catch {
    parentSlot.textContent = "post unavailable";
  }
}

function renderThreadParentArticle(item: ReturnType<typeof feedPostToUnifiedItem>): HTMLElement {
  // Use renderStream to draw the single parent into a temp container
  // so we get the same stream-post DOM as the feed list (action row,
  // replies panel slot). The component layer doesn't expose a direct
  // single-item renderer.
  const tmp = document.createElement("div");
  renderStream(tmp, [item]);
  const article = tmp.querySelector<HTMLElement>(".stream-post");
  if (article === null) {
    const fallback = document.createElement("div");
    fallback.textContent = "post unavailable";
    return fallback;
  }
  return article;
}

// Tiny helper that returns the viewer's canonical id or undefined.
// Wraps the optional-chain so callers don't have to repeat the
// runtime null check at every render site.
function viewerCanonicalIdOrUndefined(): string | undefined {
  return currentIdentityDocument === null ? undefined : currentIdentityDocument.canonical_id;
}

async function refreshFeedPosts(): Promise<void> {
  if (activeThreadPostId !== null) {
    // Thread view owns the center column right now. Re-render the
    // thread instead of clobbering it with the feed list.
    await renderThreadView(activeThreadPostId);
    return;
  }
  if (currentIdentityDocument === null) {
    renderStream(streamRoot, []);
    lastFeedFingerprint = null;
    return;
  }

  // The server is the single source of truth for the personal feed:
  // it knows the viewer's connections, subscriptions, and blocks, and
  // it returns posts already filtered to top-level + author-visible
  // along with engagement (counts + viewer state) for each card.
  try {
    const response = await listPersonalFeed(currentIdentityDocument.canonical_id);
    const items = response.posts.map((post) => feedPostToUnifiedItemFromEngagement(
      post,
      response.engagement[post.post_id]
    ));
    renderStream(streamRoot, items);
    // Keep the poller's diff baseline in sync so the very next tick
    // doesn't repaint identical content.
    lastFeedFingerprint = computeFeedFingerprint(response.posts, response.engagement);
  } catch {
    renderStream(streamRoot, []);
  }
}

// Map a server-side FeedEngagement record onto the renderer's
// UnifiedFeedItem shape. Centralized so the personal feed and the
// thread view feed cards share a single converter.
function feedPostToUnifiedItemFromEngagement(
  post: FeedPost,
  engagement: FeedEngagement | undefined
): ReturnType<typeof feedPostToUnifiedItem> {
  const viewerCanonicalId = currentIdentityDocument?.canonical_id;
  if (engagement === undefined) {
    return feedPostToUnifiedItem(post, { viewerCanonicalId });
  }
  return feedPostToUnifiedItem(post, {
    counts: {
      recommend: engagement.counts.recommend,
      downrank: engagement.counts.downrank,
      reply: engagement.counts.reply,
      repost: engagement.counts.repost
    },
    vote: engagement.viewer_reaction === "recommend" ? "like"
      : engagement.viewer_reaction === "downrank" ? "dislike"
      : null,
    viewerHasReposted: engagement.viewer_has_reposted === true,
    viewerCanonicalId
  });
}

async function refreshDiscoveryPosts(mode: DiscoveryMode = discoveryState.mode): Promise<void> {
  discoveryState = { status: "loading", mode };
  renderDiscoveryPanel(discoveryRoot, discoveryState, viewerCanonicalIdOrUndefined());

  const viewer = currentIdentityDocument?.canonical_id;
  try {
    const posts = await listDiscoveryPosts(mode, 20, 0, viewer);
    discoveryState = { status: "loaded", mode, posts };
  } catch (error) {
    discoveryState = {
      status: "error",
      mode,
      message: error instanceof Error ? error.message : "discovery load failed"
    };
  }

  renderDiscoveryPanel(discoveryRoot, discoveryState, viewerCanonicalIdOrUndefined());
}

async function postDiscoveryReaction(
  postId: string,
  reaction: ReactionKind
): Promise<void> {
  if (currentIdentityDocument === null) return;
  const reactionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const signature = currentCryptoAccount === null
    ? undefined
    : await signDiscoveryReaction(
        {
          type: "sudo_discovery_reaction",
          protocol_version: "0.1.0",
          reaction_id: reactionId,
          post_id: postId,
          actor_canonical_id: currentIdentityDocument.canonical_id,
          actor_handle: currentIdentityDocument.handle,
          reaction,
          created_at: createdAt
        },
        currentCryptoAccount.identity_key,
        currentCryptoAccount.identity_key_type
      );

  await createDiscoveryReaction({
    reaction_id: reactionId,
    post_id: postId,
    actor_canonical_id: currentIdentityDocument.canonical_id,
    actor_handle: currentIdentityDocument.handle,
    reaction,
    created_at: createdAt,
    signature
  });
}

async function handleVoteCycle(postId: string, currentState: string): Promise<void> {
  if (currentIdentityDocument === null) {
    flashFeedback("sign in to vote");
    return;
  }
  const ownerCanonicalId = currentIdentityDocument.canonical_id;
  // neutral → like → dislike → neutral
  try {
    if (currentState === "neutral") {
      await postDiscoveryReaction(postId, "recommend");
    } else if (currentState === "liked") {
      // Switching to dislike: backend will replace recommend with downrank.
      await postDiscoveryReaction(postId, "downrank");
    } else {
      // disliked → clear
      await clearDiscoveryVote(postId, ownerCanonicalId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/duplicate|already|conflict/i.test(message)) {
      console.warn("[feed] vote failed", message);
    }
  }
  await refreshDiscoveryPosts();
  await refreshFeedPosts();
}

async function handleRepost(postId: string): Promise<void> {
  if (currentIdentityDocument === null) {
    flashFeedback("sign in to repost");
    return;
  }
  // Subtle confirmation: a single click reposts immediately. We don't
  // open a quote composer for MVP — quote-less reposts only.
  try {
    const newPostId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const signablePost = {
      type: "sudo_feed_post" as const,
      protocol_version: "0.1.0",
      post_id: newPostId,
      author_canonical_id: currentIdentityDocument.canonical_id,
      author_handle: currentIdentityDocument.handle,
      visibility: "public" as const,
      public_metadata: { tags: [] as string[] },
      allowed_recipients: [],
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null,
      sequence: 1,
      kind: "repost" as const,
      repost_of: postId
    };
    const signature = currentCryptoAccount === null
      ? undefined
      : await signFeedPost(signablePost, currentCryptoAccount.feed_key, currentCryptoAccount.identity_key_type);
    await createFeedPost({
      post_id: newPostId,
      author_canonical_id: currentIdentityDocument.canonical_id,
      author_handle: currentIdentityDocument.handle,
      visibility: "public",
      public_metadata: { tags: [] },
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null,
      sequence: 1,
      signature,
      kind: "repost",
      repost_of: postId
    });
    flashFeedback("reposted");
  } catch (error) {
    if (error instanceof FeedPostError && error.code === "duplicate_repost") {
      flashFeedback("you've already reposted this post");
    } else if (error instanceof FeedPostError && error.code === "cannot_repost_own_post") {
      flashFeedback("you can't repost your own post");
    } else if (error instanceof FeedPostError && error.code === "rate_limited") {
      const seconds = error.retry_after_seconds ?? 5;
      flashFeedback(`wait ${seconds}s before posting again`);
    } else {
      flashFeedback(error instanceof Error ? error.message : "repost failed");
    }
  }
  await refreshDiscoveryPosts();
  await refreshFeedPosts();
}

function toggleReplyComposer(postId: string, article: HTMLElement): void {
  const panel = article.querySelector<HTMLElement>(`[data-replies-panel="${cssEscape(postId)}"]`);
  if (panel === null) return;
  // Three states: hidden (no panel), "list" (replies visible, no
  // composer — shown after a successful submit), "compose" (composer
  // open with replies visible). Tap-toggle behavior:
  //   hidden  → compose
  //   list    → compose (re-open empty composer)
  //   compose → hidden (collapse)
  if (!panel.hidden && panel.dataset["mode"] === "compose") {
    panel.hidden = true;
    panel.replaceChildren();
    panel.dataset["mode"] = "";
    return;
  }
  openReplyComposer(postId, panel);
}

function openReplyComposer(
  postId: string,
  panel: HTMLElement,
  preloadedReplies?: FeedPost[],
  focusedReplyId?: string
): void {
  panel.hidden = false;
  panel.dataset["mode"] = "compose";
  const form = document.createElement("div");
  form.className = "stream-post__reply-form";
  const textarea = document.createElement("textarea");
  textarea.className = "stream-post__reply-input";
  textarea.placeholder = "write a reply...";
  textarea.rows = 2;
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "stream-post__reply-submit";
  submit.textContent = "reply";
  form.append(textarea, submit);
  // If we already have a list rendered (we're moving from "list"
  // back to "compose"), keep it; otherwise build a fresh container.
  const existingList = panel.querySelector<HTMLElement>(".stream-post__reply-list");
  const existingFocus = panel.querySelector<HTMLElement>(".stream-post__reply-focused");
  panel.replaceChildren(form);
  if (existingFocus !== null) panel.append(existingFocus);
  if (existingList !== null) panel.append(existingList);

  // Thread view passes replies in via the thread payload so we can
  // skip the network round-trip. The feed-list path doesn't have
  // them preloaded and falls back to the dedicated replies endpoint.
  if (preloadedReplies !== undefined) {
    renderRepliesIntoPanel(postId, panel, preloadedReplies, focusedReplyId);
  } else {
    void renderRepliesUnder(postId, panel, focusedReplyId);
  }
  // Focus the input only when we're not arriving via a notification
  // pin — pinning a reply at the top is the visible signal we want
  // the user to read first; auto-focus would scroll past it.
  if (focusedReplyId === undefined) textarea.focus();
}

async function renderRepliesUnder(
  rootPostId: string,
  panel: HTMLElement,
  focusedReplyId?: string
): Promise<void> {
  if (currentIdentityDocument === null) return;
  let replies: FeedPost[] = [];
  try {
    replies = await listFeedPostReplies(rootPostId, currentIdentityDocument.canonical_id);
  } catch {
    return;
  }
  renderRepliesIntoPanel(rootPostId, panel, replies, focusedReplyId);
}

// Builds a reply tree from a flat descendants array and paints it into
// the supplied panel. The renderer enforces a maximum visible nest
// depth (deeper replies stack flat under level 2) and renders each
// comment as a full-width row whose header keeps @handle and timestamp
// adjacent. There is no "replying to @X" / "@X replied" copy — the
// indentation alone communicates the relationship.
function renderRepliesIntoPanel(
  rootPostId: string,
  panel: HTMLElement,
  replies: FeedPost[],
  focusedReplyId?: string
): void {
  // Drop any prior focus pin; we'll re-render it below if relevant.
  panel.querySelectorAll(".stream-post__reply-focused").forEach((node) => node.remove());

  let list = panel.querySelector<HTMLElement>(".stream-post__reply-list");
  if (list === null) {
    list = document.createElement("ul");
    list.className = "stream-post__reply-list";
    panel.append(list);
  }
  list.replaceChildren();

  // Resolve the focused reply (if any) before building the tree.
  // The pinned card at the top of the panel is rendered as a list
  // entry on its own; the same reply is filtered out of the normal
  // tree below to keep dedup honest.
  const focusedReply = typeof focusedReplyId === "string" && focusedReplyId.length > 0
    ? replies.find((r) => r.post_id === focusedReplyId) ?? null
    : null;

  if (replies.length === 0) {
    const empty = document.createElement("li");
    empty.className = "stream-post__reply-empty";
    empty.textContent = "no replies yet";
    list.append(empty);
    if (focusedReplyId !== undefined && focusedReply === null) {
      // Notification pointed at a reply that no longer exists or is
      // not visible to this viewer. Surface a graceful note rather
      // than a broken-looking empty thread.
      const missing = document.createElement("div");
      missing.className = "stream-post__reply-focused-missing";
      missing.textContent = "comment unavailable — it may have been deleted";
      panel.insertBefore(missing, list);
    }
    return;
  }

  // Build the focus pin first so it sits above the normal tree.
  if (focusedReply !== null) {
    const pin = document.createElement("div");
    pin.className = "stream-post__reply-focused";
    pin.dataset["focusedReplyFor"] = rootPostId;
    pin.dataset["focusedReplyId"] = focusedReply.post_id;
    const label = document.createElement("div");
    label.className = "stream-post__reply-focused-label";
    label.textContent = "new reply";
    pin.append(label);
    const focusedItem = renderReply(focusedReply, 1, 0);
    focusedItem.classList.add("is-focused");
    pin.append(focusedItem);
    panel.insertBefore(pin, list);

    // First render after a notification click: scroll the pin into
    // view and run a one-shot flash animation. Subsequent re-renders
    // (driven by the live poller every few seconds) hit this
    // function with focusedCommentScrollPending === false, so the
    // user isn't yanked back to the pin while reading further down.
    if (focusedCommentScrollPending) {
      focusedCommentScrollPending = false;
      pin.classList.add("is-flash");
      // Defer to the next frame so layout has settled before
      // scrolling and starting the transition.
      window.requestAnimationFrame(() => {
        pin.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      window.setTimeout(() => {
        pin.classList.remove("is-flash");
      }, 1000);
    }
  } else if (focusedReplyId !== undefined) {
    const missing = document.createElement("div");
    missing.className = "stream-post__reply-focused-missing";
    missing.textContent = "comment unavailable — it may have been deleted";
    panel.insertBefore(missing, list);
  }

  const byParent = new Map<string, FeedPost[]>();
  const ids = new Set(replies.map((reply) => reply.post_id));
  for (const reply of replies) {
    if (focusedReply !== null && reply.post_id === focusedReply.post_id) {
      // Skip the pinned reply in the regular tree to avoid the same
      // comment appearing twice.
      continue;
    }
    const parent = typeof reply.reply_to === "string" && ids.has(reply.reply_to)
      ? reply.reply_to
      : rootPostId;
    const bucket = byParent.get(parent) ?? [];
    bucket.push(reply);
    byParent.set(parent, bucket);
  }
  for (const bucket of byParent.values()) {
    bucket.sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  renderReplyTree(rootPostId, 1, list, byParent);
}

// Visible nesting cap. Beyond this, replies render flat under the
// deepest visible parent so a long chain doesn't march off the right
// edge of the column.
const MAX_REPLY_NEST_DEPTH = 2;

function renderReplyTree(
  parentId: string,
  depth: number,
  container: HTMLElement,
  byParent: Map<string, FeedPost[]>
): void {
  const children = byParent.get(parentId) ?? [];
  for (const reply of children) {
    const grandchildren = byParent.get(reply.post_id) ?? [];
    const item = renderReply(reply, depth, grandchildren.length);
    if (grandchildren.length > 0) {
      const content = item.querySelector<HTMLElement>(":scope > .stream-post__reply-content");
      if (content !== null) {
        const sublist = document.createElement("ul");
        sublist.className = "stream-post__reply-list stream-post__reply-list--nested";
        sublist.dataset["sublistFor"] = reply.post_id;
        content.append(sublist);
        renderReplyTree(reply.post_id, depth + 1, sublist, byParent);
      }
    }
    container.append(item);
  }
}

function renderReply(reply: FeedPost, depth: number, childCount: number): HTMLLIElement {
  // Reply layout: a 2-column grid of [arrow gutter | content column].
  // Everything that belongs to this reply (header, body, actions,
  // inline composer, child replies) lives inside the content column
  // so it flows vertically — that's what keeps the inline composer
  // from overlapping the body and ensures children are pushed down
  // when one is appended.
  const item = document.createElement("li");
  item.className = "stream-post__reply-item";
  item.dataset["postId"] = reply.post_id;
  item.dataset["depth"] = String(Math.min(depth, MAX_REPLY_NEST_DEPTH));

  const arrow = document.createElement("span");
  arrow.className = "stream-post__reply-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "↳";

  const content = document.createElement("div");
  content.className = "stream-post__reply-content";

  const meta = document.createElement("div");
  meta.className = "stream-post__reply-meta";
  const handle = document.createElement("span");
  handle.className = "stream-post__reply-handle";
  handle.textContent = reply.author_handle ?? shortCanonicalForUi(reply.author_canonical_id);
  const time = document.createElement("span");
  time.className = "stream-post__reply-time";
  time.textContent = formatPostTimestamp(reply.created_at);
  meta.append(handle, time);

  const body = document.createElement("div");
  body.className = "stream-post__reply-body";
  body.textContent = reply.body ?? "";

  const actions = document.createElement("div");
  actions.className = "stream-post__reply-actions";

  const replyButton = document.createElement("button");
  replyButton.type = "button";
  replyButton.className = "stream-post__reply-action";
  replyButton.dataset["replyAction"] = "open-nested";
  replyButton.dataset["replyTarget"] = reply.post_id;
  replyButton.textContent = "↩ reply";
  actions.append(replyButton);

  if (childCount > 0) {
    // Collapse control sits inline with the reply action, not on a
    // dedicated row. Keeps the action surface compact and matches
    // how X-style threads handle expand/collapse.
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "stream-post__reply-collapse";
    collapse.dataset["collapseTarget"] = reply.post_id;
    collapse.dataset["collapsed"] = "false";
    collapse.setAttribute("aria-label", "collapse replies");
    collapse.textContent = "[-]";
    actions.append(collapse);
  }

  content.append(meta, body, actions);
  item.append(arrow, content);
  return item;
}

function toggleNestedComposer(article: HTMLElement, rootPostId: string, replyTargetPostId: string): void {
  const replyItem = article.querySelector<HTMLElement>(
    `.stream-post__reply-item[data-post-id="${cssEscape(replyTargetPostId)}"]`
  );
  if (replyItem === null) return;
  const content = replyItem.querySelector<HTMLElement>(":scope > .stream-post__reply-content");
  if (content === null) return;
  // The composer goes into the reply's content column so it sits
  // below the meta/body/actions and pushes any sublist of children
  // downward in normal flow. If one's already attached, toggle it
  // closed.
  const existing = content.querySelector<HTMLElement>(":scope > .stream-post__reply-form--nested");
  if (existing !== null) {
    existing.remove();
    return;
  }
  const form = document.createElement("div");
  form.className = "stream-post__reply-form stream-post__reply-form--nested";
  const textarea = document.createElement("textarea");
  textarea.className = "stream-post__reply-input";
  textarea.placeholder = "write a reply...";
  textarea.rows = 2;
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "stream-post__reply-submit";
  submit.dataset["replyTarget"] = replyTargetPostId;
  submit.dataset["replyRoot"] = rootPostId;
  submit.textContent = "reply";
  form.append(textarea, submit);
  // Insert before the sublist (if present) so the composer always
  // sits between the actions and the child replies, never on top of
  // a child.
  const sublist = content.querySelector<HTMLElement>(":scope > .stream-post__reply-list");
  if (sublist !== null) {
    content.insertBefore(form, sublist);
  } else {
    content.append(form);
  }
  textarea.focus();
}

function shortCanonicalForUi(canonical: string): string {
  if (canonical.length <= 24) return canonical;
  return `${canonical.slice(0, 18)}...${canonical.slice(-6)}`;
}

async function handleReplySubmit(
  rootPostId: string,
  replyTargetPostId: string,
  submitButton: HTMLButtonElement,
  article: HTMLElement
): Promise<void> {
  if (currentIdentityDocument === null) {
    flashFeedback("sign in to reply");
    return;
  }
  const panel = article.querySelector<HTMLElement>(`[data-replies-panel="${cssEscape(rootPostId)}"]`);
  if (panel === null) return;
  // The composer that owns this submit can be the root composer
  // (lives directly under .stream-post__replies) or a nested
  // composer attached to a specific reply <li>. Either way the
  // textarea is the closest sibling .stream-post__reply-input.
  const form = submitButton.closest<HTMLElement>(".stream-post__reply-form");
  const textarea = form?.querySelector<HTMLTextAreaElement>(".stream-post__reply-input");
  if (form === null || form === undefined || textarea === null || textarea === undefined) return;
  const body = textarea.value.trim();
  if (body.length === 0) return;
  textarea.disabled = true;
  submitButton.disabled = true;
  // Surface inline error state under the form for rate-limit etc.,
  // and clear it on each submit attempt.
  let errorLine = form.querySelector<HTMLElement>(".stream-post__reply-error");
  if (errorLine !== null) errorLine.remove();
  try {
    const newPostId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const signablePost = {
      type: "sudo_feed_post" as const,
      protocol_version: "0.1.0",
      post_id: newPostId,
      author_canonical_id: currentIdentityDocument.canonical_id,
      author_handle: currentIdentityDocument.handle,
      visibility: "public" as const,
      body,
      public_metadata: { tags: [] as string[] },
      allowed_recipients: [],
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null,
      sequence: 1,
      kind: "reply" as const,
      reply_to: replyTargetPostId
    };
    const signature = currentCryptoAccount === null
      ? undefined
      : await signFeedPost(signablePost, currentCryptoAccount.feed_key, currentCryptoAccount.identity_key_type);
    await createFeedPost({
      post_id: newPostId,
      author_canonical_id: currentIdentityDocument.canonical_id,
      author_handle: currentIdentityDocument.handle,
      visibility: "public",
      body,
      public_metadata: { tags: [] },
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null,
      sequence: 1,
      signature,
      kind: "reply",
      reply_to: replyTargetPostId
    });
    textarea.value = "";
    // Collapse this composer (root or nested). The replies list
    // stays visible — the new reply will be threaded into place by
    // renderRepliesUnder below.
    if (form.classList.contains("stream-post__reply-form--nested")) {
      form.remove();
    } else {
      form.remove();
      panel.dataset["mode"] = "list";
    }
    await renderRepliesUnder(rootPostId, panel);
    try {
      const updated = await getDiscoveryPost(rootPostId, currentIdentityDocument.canonical_id);
      const counter = article.querySelector<HTMLElement>(
        ".stream-post__action[data-reaction='reply'] .stream-post__action-count"
      );
      if (counter !== null) counter.textContent = String(updated.reply_count ?? 0);
    } catch {
      // Discovery index may not exist for non-public parents — that's
      // fine; the reply still posted and the list shows it.
    }
  } catch (error) {
    // Preserve the user's typed text and re-enable the inputs so they
    // can retry. Rate-limit and other typed errors render inline
    // under the form.
    textarea.disabled = false;
    submitButton.disabled = false;
    const message = describeFeedSubmitError(error);
    errorLine = document.createElement("div");
    errorLine.className = "stream-post__reply-error";
    errorLine.textContent = message;
    form.append(errorLine);
    return;
  }
}

function describeFeedSubmitError(error: unknown): string {
  if (error instanceof FeedPostError) {
    if (error.code === "rate_limited") {
      const seconds = error.retry_after_seconds ?? 5;
      return `wait ${seconds}s before posting again`;
    }
    if (error.code === "duplicate_repost") return "you've already reposted this post";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "post failed";
}

function cssEscape(value: string): string {
  // CSS.escape isn't typed in older lib.dom but is widely available.
  const cssApi = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
  if (cssApi !== undefined && typeof cssApi.escape === "function") return cssApi.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (match) => `\\${match}`);
}

async function handleLookupRelationshipAction(
  action: string,
  trigger?: HTMLElement
): Promise<void> {
  if (currentIdentityDocument === null || lookupState.status !== "resolved") {
    return;
  }

  const ownerCanonicalId = currentIdentityDocument.canonical_id;
  const subjectCanonicalId = lookupState.identity.canonical_id;
  const handle = lookupState.identity.handle;

  // Removing a connection is destructive enough to warrant a quick
  // confirm step. Block/unblock has its own clear "block" semantics
  // and skips the prompt; set-unknown when the prior state was
  // already "unknown" (no row) is a no-op so we skip there too.
  if (action === "set-unknown") {
    const priorTier = currentLookupRelationship?.tier;
    if (priorTier === "known" || priorTier === "close") {
      const confirmed = await confirmRemoveConnection(trigger);
      if (!confirmed) return;
    }
  }

  try {
    if (action === "set-known" || action === "set-close") {
      const tier = action === "set-known" ? "known" : "close";
      await upsertConnectionRelationship({
        owner_canonical_id: ownerCanonicalId,
        subject_canonical_id: subjectCanonicalId,
        subject_handle: handle,
        tier,
        subscribed: true
      });
      // Intentionally do NOT mirror this into local contacts. Chats
      // unlock only when both sides have explicitly followed each
      // other; the contact (and chat row) is upserted by the
      // notifications client when the server-derived
      // `connection_confirmed` notification fires.
    } else if (action === "set-block") {
      await upsertConnectionRelationship({
        owner_canonical_id: ownerCanonicalId,
        subject_canonical_id: subjectCanonicalId,
        subject_handle: handle,
        tier: "blocked",
        subscribed: false
      });
      // Block hides the contact from the chat list (listConversations
      // skips blocked) which lets the search row return to "+" when
      // appropriate. The contact row is kept (with tier=blocked) so
      // we can show "blocked" state if needed.
      await applyContactUpsertWithBroadcast(ownerCanonicalId, {
        canonical_id: subjectCanonicalId,
        handle,
        tier: "blocked",
        added_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        fingerprint: lookupState.identity.visual_fingerprint?.fingerprint
      });
    } else if (action === "set-unblock" || action === "set-unknown") {
      await deleteConnectionRelationship(ownerCanonicalId, subjectCanonicalId);
      // Drop the local contact entirely — the user is back to
      // "unknown" relationship, the chat row should disappear, and
      // the directory "+" should return.
      await applyContactDeleteWithBroadcast(ownerCanonicalId, subjectCanonicalId);
    } else if (action === "set-subscribe") {
      await applySubscriptionUpsertWithBroadcast(ownerCanonicalId, {
        author_canonical_id: subjectCanonicalId,
        author_handle: handle,
        include_public: true,
        include_connections: true,
        include_close: currentLookupRelationship?.tier === "close",
        muted: false
      });
    } else if (action === "set-unsubscribe") {
      await applySubscriptionDeleteWithBroadcast(ownerCanonicalId, subjectCanonicalId);
    }

    await refreshLookupRelationship();
    if (searchState.status === "results") {
      await runSearch(searchState.query);
    }
    // Adding a connection should backfill the new author's posts;
    // removing one should drop them. Refreshing the personal feed
    // immediately reflects the change without a manual reload.
    await refreshPersonalFeed();
    // Tell sibling tabs to refresh their feed too. We deliberately
    // don't broadcast "contacts" here — that fires for chat-partner
    // writes and would pile feed refreshes onto every incoming
    // message. "feed" is the right channel for relationship-driven
    // backfill across tabs.
    broadcastLocalStateChange("feed", ownerCanonicalId);
  } catch (error) {
    flashFeedback(error instanceof Error ? error.message : "relationship update failed");
  }
}

async function refreshLookupRelationship(): Promise<void> {
  if (currentIdentityDocument === null || lookupState.status !== "resolved") {
    return;
  }

  const ownerCanonicalId = currentIdentityDocument.canonical_id;
  const subjectCanonicalId = lookupState.identity.canonical_id;
  const [relationship, subscriptions] = await Promise.all([
    getConnectionRelationship(ownerCanonicalId, subjectCanonicalId).catch(() => null),
    listFeedSubscriptions(ownerCanonicalId).catch(() => [])
  ]);

  setLookupState({
    ...lookupState,
    relationship: relationship ?? undefined,
    subscription: subscriptions.find((subscription) => subscription.author_canonical_id === subjectCanonicalId) ?? null
  });
}

async function submitFeedPost(): Promise<void> {
  if (currentIdentityDocument === null) {
    feedComposerState.textContent = "sign in before posting";
    return;
  }

  const body = feedBodyInput.value.trim();
  if (body.length === 0) {
    feedComposerState.textContent = "write something first";
    return;
  }

  const visibility = "public" as const;
  feedComposerState.textContent = "posting...";

  try {
    const postId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const signablePost = {
      type: "sudo_feed_post" as const,
      protocol_version: "0.1.0",
      post_id: postId,
      author_canonical_id: currentIdentityDocument.canonical_id,
      author_handle: currentIdentityDocument.handle,
      visibility,
      body,
      public_metadata: { tags: [] as string[] },
      allowed_recipients: [],
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null,
      sequence: 1
    };
    const signature = currentCryptoAccount === null
      ? undefined
      : await signFeedPost(signablePost, currentCryptoAccount.feed_key, currentCryptoAccount.identity_key_type);

    await createFeedPost({
      post_id: postId,
      author_canonical_id: currentIdentityDocument.canonical_id,
      author_handle: currentIdentityDocument.handle,
      visibility,
      body,
      public_metadata: { tags: [] },
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null,
      sequence: 1,
      signature
    });
    feedBodyInput.value = "";
    autoGrowTextarea(feedBodyInput, 32, 280);
    // Quiet success: don't leave a "posted" status hanging in the UI; the
    // new post appearing in the stream is the confirmation.
    feedComposerState.textContent = "";
    await refreshFeedPosts();
    // Tell sibling tabs of this account to refresh their feed.
    if (currentIdentityDocument !== null) {
      broadcastLocalStateChange("feed", currentIdentityDocument.canonical_id);
    }
  } catch (error) {
    // Preserve the user's text on any failure so they can retry. Map
    // common server errors to clear inline copy.
    if (error instanceof FeedPostError && error.code === "rate_limited") {
      const seconds = error.retry_after_seconds ?? 5;
      feedComposerState.textContent = `wait ${seconds}s before posting again`;
    } else {
      feedComposerState.textContent = error instanceof Error ? error.message : "post failed";
    }
  }
}

// lockLocalKeysFlow removed in the recovery-posture pass. The model
// users now hold is: sign in unlocks this device, sign out ends the
// session, reset browser deletes local data. A separate "lock"
// action was redundant. Sign-out (which also calls
// lockBrowserCryptoAccount) is the right way to step away from a
// shared device.

async function exportEncryptedBackup(): Promise<void> {
  if (currentIdentityDocument === null) {
    flashFeedback("sign in to back up your account");
    return;
  }
  const passphrase = prompt("Backup passphrase. This never leaves this browser.");
  if (passphrase === null || passphrase.length === 0) {
    flashFeedback("backup cancelled");
    return;
  }

  try {
    const backup = await createEncryptedBackup(currentIdentityDocument.canonical_id, passphrase);
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sudo-backup-${backup.created_at.slice(0, 10)}.sudo-backup.json`;
    link.click();
    URL.revokeObjectURL(url);
    // Stamp the moment a backup was actually exported and broadcast
    // it via the profile slice so any linked device flips its
    // recovery posture too. applyProfileUpsertWithBroadcast handles
    // both the local putSetting and the sync event publish.
    void applyProfileUpsertWithBroadcast(currentIdentityDocument.canonical_id, { last_backup_at: backup.created_at }).catch(() => {});
    // Recovery posture just changed — clear the reminder banner and
    // refresh the menu indicator so the user sees the lever pull
    // land on the same render frame as the toast.
    clearRecoveryReminderForCurrentAccount();
    void refreshAccountMenuRecoveryIndicator();
    flashFeedback("encrypted backup exported");
  } catch (error) {
    flashFeedback(error instanceof Error ? error.message : "backup export failed");
  }
}

async function importSelectedBackup(file: File, passphrase: string): Promise<void> {
  let imported;
  try {
    const backup = JSON.parse(await file.text()) as EncryptedSudoBackup;
    imported = await importEncryptedBackup(backup, passphrase);
    await refreshLocalChats();
    await refreshLocalStorageStatus();
    flashFeedback("encrypted backup imported");
  } catch {
    flashFeedback("backup import failed");
    return;
  }
  // Chain straight into the challenge-flow signin so the user lands
  // signed-in instead of being dumped on the signin form to retype
  // the passphrase they just typed. The restored crypto_account is
  // already in IndexedDB; runSignin unlocks it locally and mints a
  // server session via /api/identity/challenge + session-from-challenge.
  if (imported.handle !== null) {
    await runSignin(imported.handle, passphrase);
  }
}

async function clearLocalStateWithConfirmation(): Promise<void> {
  if (!confirm("Clear local sudo state on this device? Export an encrypted backup first.")) return;
  await clearLocalDb();
  localChats = [];
  renderChatList(chatsRoot, localChats);
  await initializeLocalState();
  await refreshLocalStorageStatus();
  flashFeedback("device reset");
}

function setCurrentIdentity(identity: IdentityDocument, fingerprint: string): void {
  currentIdentityDocument = identity;
  currentIdentityFingerprint = fingerprint;
  // currentIdentity / currentIdentityFingerprint feed the top-right
  // account menu (handle + fingerprint). The lower-left identity
  // panel was removed in favor of notifications, so there is no
  // separate identity render call here.
  currentIdentity = buildIdentityView(identity, fingerprint);
  void refreshDevicePanel();
  void refreshLookupRelationship();
  void refreshFeedPosts();
  renderDiscoveryPanel(discoveryRoot, discoveryState, viewerCanonicalIdOrUndefined());
  if (searchState.status === "results") {
    void runSearch(searchState.query);
  }
}

function getIdentityPublicKey(identity: IdentityDocument): string {
  return identity.keys?.identity.public_key ?? identity.public_key ?? "";
}

function scheduleSearch(value: string): void {
  if (searchDebounce !== null) {
    window.clearTimeout(searchDebounce);
  }

  searchDebounce = window.setTimeout(() => {
    void runSearch(value);
  }, 150);
}

async function runSearch(rawQuery: string): Promise<void> {
  const query = normalizeLookupInput(rawQuery);
  if (query.length === 0) {
    setSearchState({ status: "idle" });
    return;
  }

  activeSearch?.abort();
  const controller = new AbortController();
  activeSearch = controller;
  setSearchState({ status: "loading", query });

  try {
    const results = await searchHandles(query, controller.signal);
    // Drop self from live results — you cannot add yourself as a
    // contact, follow yourself, or chat with yourself, so showing
    // your own row only creates dead-end clicks.
    const visibleResults = currentIdentityDocument === null
      ? results
      : results.filter((result) => result.canonical !== currentIdentityDocument!.canonical_id);
    const enrichedResults = await enrichSearchResults(visibleResults);
    if (controller.signal.aborted) return;
    setSearchState({ status: "results", query, results: enrichedResults });
  } catch (error) {
    if (controller.signal.aborted) return;
    setSearchState({
      status: "error",
      query,
      message: error instanceof Error ? error.message : "search failed",
    });
  }
}

async function enrichSearchResults(results: SearchResult[]): Promise<SearchResult[]> {
  if (currentIdentityDocument === null || results.length === 0) {
    return results;
  }

  const ownerCanonicalId = currentIdentityDocument.canonical_id;
  const subscriptions = await listFeedSubscriptions(ownerCanonicalId).catch(() => []);
  const enriched = await Promise.all(results.map(async (result) => {
    const relationship = await getConnectionRelationship(ownerCanonicalId, result.canonical).catch(() => null);

    return {
      ...result,
      relationship: relationship ?? undefined,
      subscription: subscriptions.find((subscription) => subscription.author_canonical_id === result.canonical) ?? null
    };
  }));

  return enriched;
}

function setSearchState(nextState: SearchState): void {
  searchState = nextState;
  renderSearchResults(searchResultsRoot, searchState, getFollowedCanonicals(), pendingAddedCanonicals, toggleChatTarget);
}

// Search-row toggle is FOLLOW only. Following subscribes to the
// peer's public feed and triggers a follow notification on their
// side. It does NOT create a chat target, a "known" relationship,
// or a local contact — chats unlock only after the server has
// observed reciprocal subscriptions and emitted a
// `connection_confirmed` notification, which the notifications
// client handles by upserting the contact at tier=known.
function toggleChatTarget(result: SearchResult): void {
  if (pendingAddedCanonicals.has(result.canonical)) {
    setSearchState(searchState);
    return;
  }

  if (getFollowedCanonicals().has(result.canonical)) {
    void unfollowFromSearch(result);
    return;
  }

  void followFromSearch(result);
}

async function followFromSearch(result: SearchResult): Promise<void> {
  pendingAddedCanonicals.add(result.canonical);
  if (currentIdentityDocument === null) {
    setSearchState(searchState);
    return;
  }
  const ownerCanonicalId = currentIdentityDocument.canonical_id;
  await applySubscriptionUpsertWithBroadcast(ownerCanonicalId, {
    author_canonical_id: result.canonical,
    author_handle: result.handle,
    include_public: true,
    include_connections: true,
    include_close: false,
    muted: false
  });
  // Mirror the new subscription into the in-memory search results so
  // the row label flips to "following" without waiting for the next
  // debounced search.
  applySubscriptionToSearchState(result.canonical, {
    type: "sudo_feed_subscription",
    owner_canonical_id: ownerCanonicalId,
    author_canonical_id: result.canonical,
    author_handle: result.handle,
    include_public: true,
    include_connections: true,
    include_close: false,
    muted: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  await refreshPersonalFeed();
  broadcastLocalStateChange("feed", ownerCanonicalId);
  setSearchState(searchState);

  const existingTimer = pendingAddedTimers.get(result.canonical);
  if (existingTimer !== undefined) window.clearTimeout(existingTimer);
  pendingAddedTimers.set(result.canonical, window.setTimeout(() => {
    pendingAddedCanonicals.delete(result.canonical);
    pendingAddedTimers.delete(result.canonical);
    setSearchState(searchState);
  }, 2000));
}

async function unfollowFromSearch(result: SearchResult): Promise<void> {
  const canonical = result.canonical;
  const timer = pendingAddedTimers.get(canonical);
  if (timer !== undefined) window.clearTimeout(timer);
  pendingAddedTimers.delete(canonical);
  pendingAddedCanonicals.delete(canonical);
  if (currentIdentityDocument !== null) {
    await applySubscriptionDeleteWithBroadcast(currentIdentityDocument.canonical_id, canonical);
  }
  applySubscriptionToSearchState(canonical, null);
  await refreshPersonalFeed();
  if (currentIdentityDocument !== null) {
    broadcastLocalStateChange("feed", currentIdentityDocument.canonical_id);
  }
  setSearchState(searchState);
}

function applySubscriptionToSearchState(canonical: string, subscription: FeedSubscription | null): void {
  if (searchState.status !== "results") return;
  searchState.results = searchState.results.map((row) =>
    row.canonical === canonical ? { ...row, subscription } : row
  );
}

function getFollowedCanonicals(): Set<string> {
  if (searchState.status !== "results") return new Set();
  const ids: string[] = [];
  for (const result of searchState.results) {
    if (result.subscription !== null && result.subscription !== undefined && result.subscription.muted !== true) {
      ids.push(result.canonical);
    }
  }
  return new Set(ids);
}

function getChatCanonical(chat: ChatSummary): string {
  return chat.canonical ?? chat.id;
}

function setAuthView(view: "menu" | "signin" | "signup" | "restore" | "signed-in"): void {
  authView = view;
  document.body.dataset["authState"] = view;
}

function openSignupDialog(): void {
  setAuthView("signup");
  setSignupState({ status: "idle" });
  clearSignupForm();
  signupDialog.showModal();
  signupInput.focus();
}

// Native <dialog>-backed confirm. Returns true if the user clicks
// "remove", false on cancel/Escape/click-outside. Restores focus to
// the triggering element so keyboard users don't lose their place.
let removeConnectionResolver: ((confirmed: boolean) => void) | null = null;
let removeConnectionTrigger: HTMLElement | null = null;
function confirmRemoveConnection(trigger?: HTMLElement): Promise<boolean> {
  if (removeConnectionResolver !== null) {
    // Modal already open — treat the new request as a cancel of
    // the previous one and chain in the new prompt.
    removeConnectionResolver(false);
    removeConnectionResolver = null;
  }
  removeConnectionTrigger = trigger ?? null;
  removeConnectionDialog.showModal();
  // Default focus on "remove" so Enter confirms when the user
  // tabs in or activates via keyboard. Escape always cancels via
  // the native <dialog> handler.
  removeConnectionConfirm.focus();
  return new Promise<boolean>((resolve) => {
    removeConnectionResolver = resolve;
  });
}

function settleRemoveConnection(confirmed: boolean): void {
  if (removeConnectionResolver !== null) {
    removeConnectionResolver(confirmed);
    removeConnectionResolver = null;
  }
  if (removeConnectionDialog.open) removeConnectionDialog.close();
  if (removeConnectionTrigger !== null) {
    try { removeConnectionTrigger.focus(); } catch { /* element gone, fine */ }
    removeConnectionTrigger = null;
  }
}

removeConnectionCancel.addEventListener("click", () => settleRemoveConnection(false));
removeConnectionConfirm.addEventListener("click", () => settleRemoveConnection(true));
// Native <dialog> fires "close" on Escape and on .close(). Make sure
// any escape path resolves the promise so callers don't hang.
removeConnectionDialog.addEventListener("close", () => {
  if (removeConnectionResolver !== null) {
    removeConnectionResolver(false);
    removeConnectionResolver = null;
  }
  if (removeConnectionTrigger !== null) {
    try { removeConnectionTrigger.focus(); } catch { /* ignore */ }
    removeConnectionTrigger = null;
  }
});

function openSigninDialog(): void {
  setAuthView("signin");
  setSigninState({ status: "idle" });
  clearSigninForm();
  signinDialog.showModal();
  signinHandleInput.focus();
}

function openRestoreDialog(): void {
  if (signupDialog.open) signupDialog.close();
  if (signinDialog.open) signinDialog.close();
  if (authView !== "signed-in") {
    setAuthView("restore");
  }
  clearRestoreForm();
  restoreDialog.showModal();
  restoreFileInput.focus();
}

function setSignedIn(handle: string): void {
  authSequence++;
  setAuthView("signed-in");
  setAccountButtonHandle(handle);
  closeChatPopup();
  if (currentIdentityDocument !== null) {
    // Resume any backfill that was left pending or failed by a
    // previous signed-in session. Fire-and-forget — the retry
    // logic enforces a backoff so we don't hot-loop if the same
    // failure recurs.
    void retryPendingBackfills(currentIdentityDocument.canonical_id);
    // Repaint chat + feed from the new owner's local state only. The previous
    // owner's in-memory state was already cleared in setSignedOut().
    void refreshLocalChats();
    void refreshFeedPosts();
    startInboxPolling(currentIdentityDocument.canonical_id);
    startFeedPolling(currentIdentityDocument.canonical_id);
    if (notificationsList !== null && notificationsEmpty !== null) {
      startNotificationsPolling(currentIdentityDocument.canonical_id, {
        list: notificationsList,
        empty: notificationsEmpty,
        clearAllButton: notificationsClearAll,
        onView: (target) => {
          // The user might be on Discover or in another mobile pane;
          // bring them to the personal feed first so the thread view
          // takes over the visible center column.
          if (activeFeedTab !== "personal") setFeedTab("personal");
          if (typeof document !== "undefined" && document.body.dataset["mobilePane"] !== undefined) {
            document.body.dataset["mobilePane"] = "feed";
            for (const button of mobileTabButtons) {
              button.classList.toggle("is-active", button.dataset["mobileTab"] === "feed");
            }
          }
          void enterThreadView(target.postId, target.focusedCommentId);
        },
        onChatTargetsChanged: () => {
          // Server-confirmed mutual follow promoted a contact to
          // tier=known. Refresh the chat list and the search-row
          // state so the user sees the new chat partner without
          // waiting for the next poll cycle.
          void refreshLocalChats();
          if (searchState.status === "results") {
            renderSearchResults(searchResultsRoot, searchState, getFollowedCanonicals(), pendingAddedCanonicals, toggleChatTarget);
          }
        }
      });
    }
  }
}

function setAccountButtonHandle(handle: string | null): void {
  if (handle === null || handle.length === 0) {
    accountButtonHandle.textContent = "";
    accountButton.removeAttribute("data-handle");
    accountMenuHandle.textContent = "";
    return;
  }
  accountButtonHandle.textContent = handle;
  accountButton.setAttribute("data-handle", handle);
  accountMenuHandle.textContent = handle;
}

function refreshRelayStatusUi(): void {
  // The account menu used to surface a "relay: ..." line that leaked
  // protocol-level wording (onion / https / local_dev) into the
  // signed-in dropdown. Cleaned up in the UX pass — relay state is
  // an operator-level concern that doesn't belong in front of users.
  // Kept as a no-op so existing callers don't need to be rewired.
}

function setAccountMenuOpen(open: boolean): void {
  accountMenu.hidden = !open;
  accountButton.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) void refreshAccountMenuRecoveryIndicator();
}

function openDevicesDialog(): void {
  void refreshDevicePanel();
  if (!devicesDialog.open) devicesDialog.showModal();
}

// Settings dialog. Single launcher for the destructive/maintenance
// surface that used to clutter the account dropdown: backup,
// restore, linked devices, and the danger-zone reset. The dialog
// itself is a thin layer — backup runs immediately, the other three
// open the existing dedicated dialogs (restore, devices) or the
// typed-RESET destructive flow.
function openSettingsDialog(): void {
  resetSettingsDangerZone();
  settingsState.textContent = "";
  if (!settingsDialog.open) settingsDialog.showModal();
  // Opening Settings is a natural moment to retry any backfill that
  // failed earlier — the user is actively engaged with their account
  // surface and the device list, so a sync that converges now is more
  // likely to be observed and trusted.
  if (currentIdentityDocument !== null) {
    void retryPendingBackfills(currentIdentityDocument.canonical_id);
  }
}

function resetSettingsDangerZone(): void {
  settingsResetConfirmInput.value = "";
  settingsResetButton.disabled = true;
  const details = document.getElementById("settings-danger");
  if (details instanceof HTMLDetailsElement) details.open = false;
}

async function runSettingsReset(): Promise<void> {
  // The reset button is gated on the user typing RESET into the
  // confirmation input, but we double-check here so a programmatic
  // .click() can't bypass the typed confirmation. Once that's
  // satisfied we drop the local IndexedDB and reload, mirroring the
  // legacy resetThisDeviceWithConfirm() flow without the
  // window.confirm() prompt (the dialog itself is the confirmation).
  if (settingsResetConfirmInput.value.trim() !== "RESET") return;
  settingsState.textContent = "clearing local data…";
  try {
    await deleteLocalDb();
  } catch (error) {
    settingsState.textContent = error instanceof Error ? error.message : "reset failed";
    return;
  }
  settingsState.textContent = "this browser is now empty. reloading…";
  window.setTimeout(() => window.location.reload(), 200);
}

// Account dialog. User-facing snapshot of who they are on this
// device: handle, visual + text fingerprint, recovery posture
// (backed up / paired device / unprotected), editable bio, and an
// "advanced" disclosure that surfaces the canonical_id for
// power-users. Nothing about relays, transports, or storage
// internals is exposed here.
async function openAccountDialog(): Promise<void> {
  if (currentIdentityDocument === null || currentIdentityFingerprint === null) {
    return;
  }
  const identity = currentIdentityDocument;
  const fingerprintHex = currentIdentityFingerprint;
  accountCardHandle.textContent = identity.handle;
  accountCardCanonical.textContent = identity.canonical_id;

  // Visual fingerprint grid. Use the document's signed fingerprint if
  // it carries one, otherwise derive from the fingerprint hex we
  // already have. Either way the user sees a deterministic glyph
  // unique to their public key.
  const grid = identity.visual_fingerprint ?? gridFromFingerprintHex(fingerprintHex);
  accountCardFingerprintGrid.replaceChildren(renderFingerprintGrid(grid));
  accountCardFingerprintText.textContent = `${fingerprintHex.slice(0, 4)}-${fingerprintHex.slice(4, 8)}-${fingerprintHex.slice(8, 12)}-${fingerprintHex.slice(12, 16)}`;

  await Promise.all([
    refreshAccountBio(identity.canonical_id),
    refreshAccountRecoveryStatus(identity.canonical_id)
  ]);
  accountState.textContent = "";
  if (!accountDialog.open) accountDialog.showModal();
}

async function refreshAccountBio(canonicalId: string): Promise<void> {
  if (accountBioInput === null) return;
  const value = await getSetting(profileBioKey(canonicalId));
  accountBioInput.value = typeof value === "string" ? value : "";
}

async function saveAccountBio(): Promise<void> {
  if (accountBioInput === null || currentIdentityDocument === null) return;
  const next = accountBioInput.value.slice(0, 280);
  accountState.textContent = "saving…";
  try {
    // applyProfileUpsertWithBroadcast writes the bio to the local
    // settings store AND publishes a profile.upsert sync event so
    // any linked device picks up the change on its next poll.
    await applyProfileUpsertWithBroadcast(currentIdentityDocument.canonical_id, { bio: next });
    accountState.textContent = "saved";
    window.setTimeout(() => {
      if (accountState.textContent === "saved") accountState.textContent = "";
    }, 1600);
  } catch (error) {
    accountState.textContent = error instanceof Error ? error.message : "save failed";
  }
}

// Recovery posture is computed in one place so the account dialog,
// the passive account-menu indicator, and the recovery reminder
// banner all derive their copy from the same signal. Two inputs
// matter: did the user export a backup (profile.lastBackupAt
// stamped on successful export), and is there at least one paired
// device that is NOT this browser. From those we collapse to four
// posture states.
type RecoveryPosture = {
  backedUp: boolean;
  pairedDeviceCount: number;
  level: "ok" | "warn" | "danger";
};

async function computeRecoveryPosture(canonicalId: string): Promise<RecoveryPosture> {
  let backedUp = false;
  let pairedDeviceCount = 0;
  try {
    const lastBackup = await getSetting(profileLastBackupKey(canonicalId));
    backedUp = typeof lastBackup === "string" && lastBackup.length > 0;
  } catch {
    backedUp = false;
  }
  try {
    const devices = await listTrustedDevices(canonicalId);
    pairedDeviceCount = devices.filter((d) => d.trust_state === "active" && d.device_id !== currentDeviceId).length;
  } catch {
    pairedDeviceCount = 0;
  }
  let level: "ok" | "warn" | "danger";
  if (backedUp && pairedDeviceCount > 0) level = "ok";
  else if (backedUp) level = "ok";
  else if (pairedDeviceCount > 0) level = "warn";
  else level = "danger";
  return { backedUp, pairedDeviceCount, level };
}

async function refreshAccountRecoveryStatus(canonicalId: string): Promise<void> {
  const posture = await computeRecoveryPosture(canonicalId);
  const lines: string[] = [];
  if (posture.backedUp && posture.pairedDeviceCount > 0) {
    lines.push("recovery: backup file + linked device");
  } else if (posture.backedUp) {
    lines.push("recovery: backup file saved");
    lines.push("tip: pair a second device for a faster recovery path.");
  } else if (posture.pairedDeviceCount > 0) {
    lines.push(`recovery: ${posture.pairedDeviceCount} linked device${posture.pairedDeviceCount > 1 ? "s" : ""}`);
    lines.push("tip: also export an encrypted backup file in case all devices are wiped.");
  } else {
    lines.push("recovery: unprotected");
    lines.push("you have no backup file and no linked devices. if this browser is wiped, the account cannot be recovered.");
  }
  accountCardStatus.classList.remove("is-ok", "is-warn", "is-danger");
  accountCardStatus.classList.add(`is-${posture.level}`);
  accountCardStatus.replaceChildren(...lines.map((text) => {
    const div = document.createElement("div");
    div.textContent = text;
    return div;
  }));
}

// Tiny passive line shown inside the account dropdown header. Subtle
// by design — green checks for what the user has, "unprotected" if
// neither. Nothing the user has to act on right now; the reminder
// banner handles active prompting.
async function refreshAccountMenuRecoveryIndicator(): Promise<void> {
  if (currentIdentityDocument === null) {
    accountMenuRecovery.textContent = "";
    accountMenuRecovery.classList.remove("is-ok", "is-warn", "is-danger");
    return;
  }
  const posture = await computeRecoveryPosture(currentIdentityDocument.canonical_id);
  const parts: string[] = [];
  if (posture.backedUp) parts.push("✓ backup");
  if (posture.pairedDeviceCount > 0) parts.push("✓ linked device");
  const text = parts.length > 0 ? parts.join("  ") : "unprotected";
  accountMenuRecovery.textContent = text;
  accountMenuRecovery.classList.remove("is-ok", "is-warn", "is-danger");
  accountMenuRecovery.classList.add(`is-${posture.level}`);
}

function profileBioKey(canonicalId: string): string {
  return `profile.bio.${canonicalId}`;
}

function profileLastBackupKey(canonicalId: string): string {
  return `profile.lastBackupAt.${canonicalId}`;
}

function profileFirstSeenKey(canonicalId: string): string {
  return `profile.firstSeenAt.${canonicalId}`;
}

function profileSigninCountKey(canonicalId: string): string {
  return `profile.signinCount.${canonicalId}`;
}

// Recovery reminder banner removed in the new-device-link UX pass.
// The yellow strip above the personal feed was visually noisy and
// the trigger logic was opaque to users. The same posture data still
// drives the passive indicator inside the account dropdown, which is
// the right surface for a calm, glanceable signal.
//
// Stubs preserved so call sites in setSignedIn / exportEncryptedBackup
// / completePairingFlow / setSignedOut don't need to be rewired in
// every patch — just compile-time no-ops.
function clearRecoveryReminderForCurrentAccount(): void { /* noop */ }
function hideRecoveryReminder(): void { /* noop */ }

function setSignedOut(): void {
  authSequence++;
  stopInboxPolling();
  stopFeedPolling();
  stopNotificationsPolling();
  // Banner is per-identity; hide it the moment the user signs out
  // so the next account (or anonymous landing) doesn't briefly
  // inherit the prior user's recovery banner.
  hideRecoveryReminder();
  currentIdentityDocument = null;
  currentIdentityFingerprint = null;
  currentCryptoAccount = null;
  currentLookupRelationship = null;
  currentLookupSubscription = null;
  setAuthView("menu");
  currentIdentity = buildAnonymousIdentityView();
  // Drop any in-memory rendered private state from the previous account so
  // the next user never briefly sees the prior user's UI.
  localChats = [];
  renderChatList(chatsRoot, localChats);
  renderStream(streamRoot, []);
  setLookupState({ status: "idle" });
  setSearchState({ status: "idle" });
  searchInput.value = "";
  feedBodyInput.value = "";
  feedComposerState.textContent = "";
  closeChatPopup();
  void refreshDevicePanel();
  renderDiscoveryPanel(discoveryRoot, discoveryState, viewerCanonicalIdOrUndefined());
  setAccountButtonHandle(null);
  setAccountMenuOpen(false);
  closeChatPopup();
  if (lookupState.status === "resolved") {
    setLookupState({
      ...lookupState,
      relationship: undefined,
      subscription: null
    });
  }
  if (searchState.status === "results") {
    void runSearch(searchState.query);
  }
  if (discoveryState.status === "loaded") {
    renderDiscoveryPanel(discoveryRoot, discoveryState, viewerCanonicalIdOrUndefined());
  }
}

async function ensureNodeDocument(): Promise<NodeCapabilityDocument> {
  if (currentNodeDocument !== null) {
    return currentNodeDocument;
  }

  currentNodeDocument = await getNodeDocument();
  refreshIdentityPane();
  return currentNodeDocument;
}

function refreshIdentityPane(): void {
  // The lower-left identity panel was removed in favor of
  // notifications. We still keep currentIdentity in sync because the
  // top-right account menu reads handle/fingerprint from it.
  if (currentIdentityDocument !== null && currentIdentityFingerprint !== null) {
    currentIdentity = buildIdentityView(currentIdentityDocument, currentIdentityFingerprint);
  } else {
    currentIdentity = buildAnonymousIdentityView();
  }
}

function buildIdentityView(identity: IdentityDocument, fingerprint: string): LocalIdentity {
  const relaySelection = selectRelayForRecipient(identity);
  return {
    handle: identity.handle,
    bio: currentCryptoAccount === null ? "account on this device" : "account unlocked",
    status: currentCryptoAccount === null ? "locked" : "unlocked",
    privacyMode: currentCryptoAccount === null ? "account locked" : "account unlocked",
    onionState: `relay: ${currentNodeDocument?.onion_base_url ?? "not advertised"}`,
    fingerprintSnippet: `${fingerprint.slice(0, 4)}...`,
    portalTransport: `portal: ${describePortalTransport(window.location.origin)}`,
    relayTransport: relaySelection.ok ? `relay: ${relaySelection.privacy_level}` : "relay: unavailable",
    relayWarning: relaySelection.ok ? relaySelection.warning : "relay: no delivery relays advertised",
    nodeName: currentNodeDocument?.name,
    nodeBaseUrl: currentNodeDocument?.public_base_url,
    nodeOnionBaseUrl: currentNodeDocument?.onion_base_url ?? null,
    nodeRoles: currentNodeDocument?.roles,
    nodeRelaySummary: currentNodeDocument === null
      ? "relay capabilities unavailable"
      : `relay capabilities: ${currentNodeDocument.relay_capabilities.map((relay) => `${relay.transport}:${relay.priority}`).join(", ")}`
  };
}

function buildAnonymousIdentityView(): LocalIdentity {
  return {
    ...localIdentity,
    portalTransport: `portal: ${describePortalTransport(window.location.origin)}`,
    onionState: `relay: ${currentNodeDocument?.onion_base_url ?? "not advertised"}`,
    relayTransport: currentNodeDocument === null
      ? localIdentity.relayTransport
      : `relay: ${currentNodeDocument.relay_capabilities[0]?.transport ?? "unavailable"}`,
    relayWarning: currentNodeDocument?.relay_capabilities[0]?.transport === "https"
      ? "HTTPS relay fallback is in use; private message transport is not onion-routed."
      : undefined,
    nodeName: currentNodeDocument?.name ?? localIdentity.nodeName,
    nodeBaseUrl: currentNodeDocument?.public_base_url ?? localIdentity.nodeBaseUrl,
    nodeOnionBaseUrl: currentNodeDocument?.onion_base_url ?? localIdentity.nodeOnionBaseUrl,
    nodeRoles: currentNodeDocument?.roles ?? localIdentity.nodeRoles,
    nodeRelaySummary: currentNodeDocument === null
      ? localIdentity.nodeRelaySummary
      : `relay capabilities: ${currentNodeDocument.relay_capabilities.map((relay) => `${relay.transport}:${relay.priority}`).join(", ")}`
  };
}

function logout(): void {
  lockBrowserCryptoAccount();
  currentCryptoAccount = null;
  clearActiveCoordinator();
  void clearDevSessionToken().then(refreshLocalStorageStatus);
  clearSignupForm();
  clearSigninForm();
  clearRestoreForm();
  signupDialog.close();
  signinDialog.close();
  restoreDialog.close();
  setSignedOut();
}

// hideRecoveryPanel/showRecoveryPanel and the backup-code copy helpers
// were removed in migration step 7. The DOM panel they targeted
// (#recovery-panel) was vestigial: its only field was a backup code
// the legacy /api/identity/signup once minted, and showRecoveryPanel
// was never called once /api/identity/signup itself was deleted in
// step 6. The post-signup nudge now lives directly in the signup
// result render in components.ts.

function renderPasskeySupport(): void {
  const support = passkeyAccessProvider.isAvailable() ? "available" : "unavailable";
  signupPasskeySupport.textContent = `passkey support: ${support}`;
  signinPasskeySupport.textContent = `passkey support: ${support}`;
}

function clearSignupForm(): void {
  signupForm.reset();
  signupInput.value = "";
  signupPasswordInput.value = "";
  signupPasswordConfirmInput.value = "";
  setSignupState({ status: "idle" });
}

function clearSigninForm(): void {
  signinForm.reset();
  signinHandleInput.value = "";
  signinPasswordInput.value = "";
  setSigninState({ status: "idle" });
}

function clearRestoreForm(): void {
  restoreForm.reset();
  restorePassphraseInput.value = "";
  restoreFileInput.value = "";
  setRestoreState({ status: "idle" });
}

function setRestoreState(nextState: { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; message: string }): void {
  restoreStateRoot.textContent = nextState.status === "idle"
    ? ""
    : nextState.status === "loading"
      ? "working..."
      : nextState.message;
  restoreStateRoot.classList.toggle("is-danger", nextState.status === "error");
}

function startBrandFlicker(): void {
  if (reducedMotionQuery.matches || brandFlickerActive) return;
  brandFlickerActive = true;
  scheduleBrandFlicker();
}

function stopBrandFlicker(): void {
  brandFlickerActive = false;
  if (brandFlickerTimeout !== null) {
    window.clearTimeout(brandFlickerTimeout);
    brandFlickerTimeout = null;
  }
  if (brandFlickerTick !== null) {
    window.clearTimeout(brandFlickerTick);
    brandFlickerTick = null;
  }
  landingBrand.textContent = brandLabel;
}

function scheduleBrandFlicker(): void {
  if (!brandFlickerActive || reducedMotionQuery.matches) {
    stopBrandFlicker();
    return;
  }

  const delay = 220 + Math.floor(Math.random() * 640);
  brandFlickerTimeout = window.setTimeout(() => {
    if (!brandFlickerActive || reducedMotionQuery.matches) {
      stopBrandFlicker();
      return;
    }

    if (Math.random() < 0.36) {
      const index = Math.floor(Math.random() * brandLabel.length);
      const char = brandFlickerPool[Math.floor(Math.random() * brandFlickerPool.length)] ?? brandLabel[index];
      const chars = brandLabel.split("");
      chars[index] = char.slice(0, 1);
      landingBrand.textContent = chars.join("");
      brandFlickerTick = window.setTimeout(() => {
        if (brandFlickerActive) landingBrand.textContent = brandLabel;
      }, 54 + Math.floor(Math.random() * 70));
    }

    scheduleBrandFlicker();
  }, delay);
}

function validatePassword(password: string): string | null {
  if (password.length < 12) return "passphrase must be at least 12 characters";
  if (!/[A-Z]/.test(password)) return "passphrase needs an uppercase letter";
  if (!/[a-z]/.test(password)) return "passphrase needs a lowercase letter";
  if (!/[0-9]/.test(password)) return "passphrase needs a number";
  if (!/[^A-Za-z0-9]/.test(password)) return "passphrase needs a symbol";
  return null;
}

type FeedTab = "personal" | "discover";

function setFeedTab(tab: FeedTab): void {
  activeFeedTab = tab;
  for (const button of feedTabButtons) {
    const isActive = button.dataset["feedTab"] === tab;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  }
  for (const pane of feedPanes) {
    pane.hidden = pane.dataset["feedPane"] !== tab;
  }
  if (tab === "discover") {
    void refreshDiscoveryPosts().catch(() => null);
  } else if (tab === "personal" && currentIdentityDocument !== null) {
    // Returning to personal must always re-fetch — the poller will
    // have seen any background updates while we were on discover but
    // intentionally didn't paint them, so the pane is otherwise
    // stale. Reset the fingerprint so the upcoming render commits.
    lastFeedFingerprint = null;
    void pollPersonalFeed();
  }
}

function autoGrowTextarea(element: HTMLTextAreaElement, minHeight: number, maxHeight: number): void {
  element.style.height = "auto";
  const next = Math.min(maxHeight, Math.max(minHeight, element.scrollHeight));
  element.style.height = `${next}px`;
  element.classList.toggle("is-overflowing", element.scrollHeight > maxHeight);
}

let feedbackTimer: number | null = null;
function flashFeedback(message: string): void {
  localMaintenanceFeedback.textContent = message;
  if (feedbackTimer !== null) window.clearTimeout(feedbackTimer);
  if (message.length === 0) return;
  feedbackTimer = window.setTimeout(() => {
    if (localMaintenanceFeedback.textContent === message) {
      localMaintenanceFeedback.textContent = "";
    }
  }, 4000);
}

// ---- floating chat popup ---------------------------------------------------
type ChatTarget = { canonical: string; handle: string; fingerprint: string };

async function openChatPopup(target: ChatTarget): Promise<void> {
  chatTarget = target;
  chatPopupHandle.textContent = target.handle || target.canonical;
  chatPopup.classList.remove("is-minimized");
  chatPopup.hidden = false;
  for (const row of chatsRoot.querySelectorAll<HTMLElement>("[data-chat-canonical]")) {
    row.classList.toggle("is-selected", row.dataset["chatCanonical"] === target.canonical);
  }
  await renderChatPopupBody(target.canonical);
  chatPopupInput.focus();
}

function closeChatPopup(): void {
  chatPopup.hidden = true;
  chatPopup.classList.remove("is-minimized");
  chatPopupInput.value = "";
  chatTarget = null;
  for (const row of chatsRoot.querySelectorAll<HTMLElement>(".is-selected")) {
    row.classList.remove("is-selected");
  }
}

async function renderChatPopupBody(canonicalId: string, options: { forceScrollToBottom?: boolean } = {}): Promise<void> {
  if (currentIdentityDocument === null) {
    chatPopupBody.replaceChildren(makeChatEmpty("sign in to chat"));
    return;
  }
  const conversationId = conversationKey(currentIdentityDocument.canonical_id, canonicalId);
  let messages: Array<{ message_id: string; created_at: string; direction: "sent" | "received"; body: string }> = [];
  try {
    messages = await listConversationMessages(conversationId);
  } catch {
    messages = [];
  }
  // Stick scroll to bottom only if the user was already near the bottom
  // before this re-render. New messages while reading older history won't
  // yank the viewport.
  const distanceFromBottom = chatPopupBody.scrollHeight - chatPopupBody.scrollTop - chatPopupBody.clientHeight;
  const wasNearBottom = distanceFromBottom < 60 || chatPopupBody.scrollHeight === 0;
  if (messages.length === 0) {
    chatPopupBody.replaceChildren(makeChatEmpty("no messages yet"));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    fragment.append(renderChatMessage(message));
  }
  chatPopupBody.replaceChildren(fragment);
  if (options.forceScrollToBottom || wasNearBottom) {
    chatPopupBody.scrollTop = chatPopupBody.scrollHeight;
  }
}

function makeChatEmpty(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "chat-popup__empty";
  element.textContent = text;
  return element;
}

function renderChatMessage(message: { message_id: string; created_at: string; direction: "sent" | "received"; body: string }): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `chat-message chat-message--${message.direction}`;
  const bubble = document.createElement("div");
  bubble.className = "chat-message__bubble";
  bubble.textContent = message.body;
  const meta = document.createElement("div");
  meta.className = "chat-message__meta";
  meta.textContent = formatChatTimestamp(message.created_at);
  wrapper.append(bubble, meta);
  return wrapper;
}

function formatChatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (sameDay) return time;
  return `${time} ${formatShortDate(date)}`;
}

function formatShortDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${pad2(date.getDate())} ${months[date.getMonth()]} ${String(date.getFullYear()).slice(-2)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function conversationKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

async function listConversationMessages(conversationId: string): Promise<Array<{ message_id: string; created_at: string; direction: "sent" | "received"; body: string }>> {
  if (currentIdentityDocument === null) return [];
  const records = await listLocalMessagesByConversation(currentIdentityDocument.canonical_id, conversationId);
  return records
    .map((record) => ({
      message_id: record.message_id,
      created_at: record.created_at,
      direction: record.direction,
      body: record.body
    }))
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

async function sendChatPopupMessage(): Promise<void> {
  if (chatTarget === null) return;
  if (currentIdentityDocument === null) {
    flashFeedback("sign in to send messages");
    return;
  }
  const body = chatPopupInput.value.trim();
  if (body.length === 0) return;
  const target = chatTarget;
  try {
    const result = await queueAndSubmitLocalMessage({
      senderCanonicalId: currentIdentityDocument.canonical_id,
      recipientCanonicalId: target.canonical,
      senderHandle: currentIdentityDocument.handle,
      recipientHandle: target.handle,
      body,
      senderAccount: currentCryptoAccount
    });
    chatPopupInput.value = "";
    autoGrowTextarea(chatPopupInput, 28, 120);
    await renderChatPopupBody(target.canonical, { forceScrollToBottom: true });
    await refreshLocalChats();
    if (!result.ok) {
      flashFeedback(`send failed: ${result.error ?? "unknown"}`);
    }
    // Trigger an immediate inbox poll so a fast reply lands without a 5s wait.
    void pollInbox();
  } catch (error) {
    const message = error instanceof Error ? error.message : "send failed";
    chatPopupBody.append(makeChatEmpty(message));
    flashFeedback(`send failed: ${message}`);
  }
}

async function renderStreamWhenReady(): Promise<void> {
  if ("fonts" in document) {
    await document.fonts.ready;
  }

  renderStream(streamRoot);
}

function getRequiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing #${id}`);
  return element;
}

function getRequiredForm(id: string): HTMLFormElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLFormElement)) throw new Error(`Missing form #${id}`);
  return element;
}

function getRequiredInput(id: string): HTMLInputElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input #${id}`);
  return element;
}

function getRequiredTextArea(id: string): HTMLTextAreaElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`Missing textarea #${id}`);
  return element;
}

function getRequiredButton(id: string): HTMLButtonElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button #${id}`);
  return element;
}

function getRequiredSelect(id: string): HTMLSelectElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`Missing select #${id}`);
  return element;
}

function getRequiredDialog(id: string): HTMLDialogElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLDialogElement)) throw new Error(`Missing dialog #${id}`);
  return element;
}



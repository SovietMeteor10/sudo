import { localIdentity } from "./data.js";
import { BrowserPasskeyAccessProvider } from "./accessProviders.js";
import {
  registerIdentityDocument,
  createDiscoveryReaction,
  completeDevicePairing,
  deleteConnectionRelationship,
  deleteFeedSubscription,
  createFeedPost,
  listDiscoveryPosts,
  getConnectionRelationship,
  fingerprintPublicKey,
  listFeedSubscriptions,
  listUserFeedPosts,
  lookupHandle,
  normalizeLookupInput,
  getNodeDocument,
  listTrustedDevices as listServerTrustedDevices,
  revokeTrustedDevice as revokeServerTrustedDevice,
  registerTrustedDevice,
  startDevicePairing,
  recoverDevHandle,
  restoreDevSession,
  searchHandles,
  signinDevHandle,
  signupDevHandle,
  upsertConnectionRelationship,
  upsertFeedSubscription
} from "./api.js";
import {
  createBrowserCryptoAccount,
  getUnlockedBrowserCryptoAccount,
  lockBrowserCryptoAccount,
  storeBrowserCryptoAccount,
  unlockBrowserCryptoAccount,
  type BrowserCryptoAccount
} from "./crypto/key-storage.js";
import { signDiscoveryReaction, signFeedPost } from "./crypto/signing.js";
import {
  renderChatList,
  renderDiscoveryPanel,
  renderDevicePanel,
  renderIdentityPane,
  renderLookupResult,
  renderSearchResults,
  renderSigninState,
  renderSignupState,
  renderStream
} from "./components.js";
import {
  clearDevSessionToken,
  readDevSessionToken,
  writeDevSessionToken
} from "./localState.js";
import { createEncryptedBackup, importEncryptedBackup, type EncryptedSudoBackup } from "./local/backup.js";
import { base64Url, randomBytes, deriveBackupKey, toBufferSource } from "./local/crypto.js";
import {
  clearLocalDb,
  getLocalStorageStatus,
  initializeLocalState,
  listConversations,
  listCryptoAccounts,
  listLocalMessagesByConversation,
  listTrustedDevices,
  getLocalDeviceMetadata,
  revokeTrustedDevice,
  saveIdentitySeen,
  saveTrustedDevice,
  upsertContact
} from "./local/local-store.js";
import { queueAndSubmitLocalMessage, retrieveRelayInboxAfterLocalSave } from "./local/relay-local.js";
import type {
  ChatSummary,
  ConnectionRelationship,
  DiscoveryMode,
  DiscoveryState,
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

const identityRoot = getRequiredElement("identity-pane-body");
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
const accountMenuFingerprint = getRequiredElement("account-menu-fingerprint");
const accountMenuBackup = getRequiredButton("account-menu-backup");
const accountMenuRestore = getRequiredButton("account-menu-restore");
const accountMenuDevices = getRequiredButton("account-menu-devices");
const accountMenuLock = getRequiredButton("account-menu-lock");
const accountMenuLogout = getRequiredButton("account-menu-logout");
const devicesDialog = getRequiredDialog("devices-dialog");
const devicesCancel = getRequiredButton("devices-cancel");
const chatPopup = getRequiredElement("chat-popup");
const chatPopupHandle = getRequiredElement("chat-popup-handle");
const chatPopupFingerprint = getRequiredElement("chat-popup-fingerprint");
const chatPopupBody = getRequiredElement("chat-popup-body");
const chatPopupForm = getRequiredForm("chat-popup-form");
const chatPopupInput = getRequiredTextArea("chat-popup-input");
const chatPopupClose = getRequiredButton("chat-popup-close");
const chatPopupMinimize = getRequiredButton("chat-popup-minimize");
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
const restoreModeRecovery = getRequiredButton("restore-mode-recovery");
const restoreModeFile = getRequiredButton("restore-mode-file");
const restoreRecoveryFields = getRequiredElement("restore-recovery-fields");
const restoreFileFields = getRequiredElement("restore-file-fields");
const restoreHandleInput = getRequiredInput("restore-handle");
const restoreBackupCodeInput = getRequiredInput("restore-backup-code");
const restoreQuestionInput = getRequiredSelect("restore-question");
const restoreAnswerInput = getRequiredInput("restore-answer");
const restoreFileInput = getRequiredInput("restore-file");
const restorePassphraseInput = getRequiredInput("restore-passphrase");
const restoreStateRoot = getRequiredElement("restore-state");
const restorePasskeySupport = getRequiredElement("restore-passkey-support");
const restoreSubmit = getRequiredButton("restore-submit");
const recoveryPanel = getRequiredElement("recovery-panel");
const recoveryPanelSecret = getRequiredElement("recovery-panel-secret");
const backupCodeCopy = getRequiredButton("backup-code-copy");
const backupCodeFeedback = getRequiredElement("backup-code-feedback");
const recoveryAck = getRequiredInput("recovery-ack");
const recoveryDismiss = getRequiredButton("recovery-dismiss");
const localStateStatus = getRequiredElement("local-storage-status");
const deviceCurrentStatus = getRequiredElement("device-current-status");
const deviceList = getRequiredElement("device-list");
const deviceLinkStart = getRequiredButton("device-link-start");
const deviceLinkComplete = getRequiredButton("device-link-complete");
const devicePairingCode = getRequiredInput("device-pairing-code");
const devicePanelFeedback = getRequiredElement("device-panel-feedback");
const localMaintenanceFeedback = getRequiredElement("local-maintenance-feedback");
const authActionButtons = [...document.querySelectorAll("[data-auth-action]")];
const landingBrand = getRequiredButton("landing-brand");

const passkeyAccessProvider = new BrowserPasskeyAccessProvider();

let lookupState: LookupState = { status: "idle" };
let signupState: SignupState = { status: "idle" };
let signinState: SigninState = { status: "idle" };
let searchState: SearchState = { status: "idle" };
let discoveryState: DiscoveryState = { status: "idle", mode: "recent" };
let currentIdentity: LocalIdentity = localIdentity;
let currentIdentityDocument: IdentityDocument | null = null;
let currentIdentityFingerprint: string | null = null;
let currentCryptoAccount: BrowserCryptoAccount | null = null;
let currentLookupRelationship: ConnectionRelationship | null = null;
let currentLookupSubscription: FeedSubscription | null = null;
let currentNodeDocument: NodeCapabilityDocument | null = null;
let currentDeviceId: string | null = null;
let activePairingCode: string | null = null;
let localChats: ChatSummary[] = [];
const pendingAddedCanonicals = new Set<string>();
const pendingAddedTimers = new Map<string, number>();
let activeLookup: AbortController | null = null;
let activeSearch: AbortController | null = null;
let searchDebounce: number | null = null;
let authSequence = 0;
let authView: "menu" | "signin" | "signup" | "restore" | "signed-in" = "menu";
let restoreMode: "recovery" | "file" = "recovery";
let activeFeedTab: "personal" | "discover" = "personal";
let chatTarget: { canonical: string; handle: string; fingerprint: string } | null = null;
let brandFlickerTimeout: number | null = null;
let brandFlickerTick: number | null = null;
let brandFlickerActive = false;
const brandLabel = "sudo";
const brandFlickerPool = ["σ", "δ", "с", "д", "す", "ド", "س", "ו", "द", "ο", "そ", "ス", "ا", "א"];
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

renderIdentityPane(identityRoot, currentIdentity);
renderLookupResult(lookupRoot, lookupState);
renderSignupState(signupStateRoot, signupState);
renderSigninState(signinStateRoot, signinState);
renderChatList(chatsRoot, localChats);
renderDiscoveryPanel(discoveryRoot, discoveryState, null);
renderSearchResults(searchResultsRoot, searchState, getAddedCanonicals(), pendingAddedCanonicals, toggleChatTarget);
renderPasskeySupport();
landingBrand.textContent = brandLabel;
setFeedTab("personal");
void initializeLocalRuntime();
void refreshNodeDocument();
void renderStreamWhenReady();
void refreshDiscoveryPosts();
void restoreStoredSession();

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
  void handleLookupRelationshipAction(action);
});

discoveryRoot.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  const mode = target.dataset["discoveryMode"] as DiscoveryMode | undefined;
  if (mode !== undefined) {
    void setDiscoveryMode(mode);
    return;
  }

  const reaction = target.dataset["discoveryReaction"];
  const postId = target.closest("[data-post-id]")?.getAttribute("data-post-id");
  if (reaction !== undefined && postId !== undefined && postId !== null && isDiscoveryReaction(reaction)) {
    void handleDiscoveryReaction(postId, reaction);
  }
});

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

restoreModeRecovery.addEventListener("click", () => setRestoreMode("recovery"));
restoreModeFile.addEventListener("click", () => setRestoreMode("file"));

recoveryAck.addEventListener("change", () => {
  syncRecoveryDismissState();
});

recoveryDismiss.addEventListener("click", () => {
  if (!recoveryAck.checked) return;
  recoveryPanel.hidden = true;
  recoveryPanelSecret.textContent = "";
  backupCodeFeedback.textContent = "";
  recoveryAck.checked = false;
  syncRecoveryDismissState();
});

backupCodeCopy.addEventListener("click", () => {
  void copyBackupCode();
});

deviceLinkStart.addEventListener("click", () => {
  void startPairingFlow();
});

deviceLinkComplete.addEventListener("click", () => {
  void completePairingFlow();
});

for (const button of authActionButtons) {
  if (!(button instanceof HTMLButtonElement)) continue;
  button.addEventListener("click", () => {
    if (button.dataset["authAction"] === "signup") {
      openSignupDialog();
    } else if (button.dataset["authAction"] === "restore") {
      openRestoreDialog();
    } else {
      openSigninDialog();
    }
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

accountMenuBackup.addEventListener("click", () => {
  setAccountMenuOpen(false);
  void exportEncryptedBackup();
});

accountMenuRestore.addEventListener("click", () => {
  setAccountMenuOpen(false);
  openRestoreDialog();
});

accountMenuDevices.addEventListener("click", () => {
  setAccountMenuOpen(false);
  openDevicesDialog();
});

accountMenuLock.addEventListener("click", () => {
  setAccountMenuOpen(false);
  void lockLocalKeysFlow();
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

// ----- chat popup -----
chatPopupClose.addEventListener("click", () => {
  closeChatPopup();
});

chatPopupMinimize.addEventListener("click", () => {
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
feedBodyInput.addEventListener("input", () => autoGrowTextarea(feedBodyInput, 32, 280));
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
    localStateStatus.textContent = `device status: ${error instanceof Error ? error.message : "unavailable"}`;
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
const INBOX_POLL_INTERVAL_MS = 5000;
let inboxPollTimer: number | null = null;
let inboxPollOwner: string | null = null;
let inboxInitialPollDone = false;
let inboxPollInFlight = false;

function startInboxPolling(canonicalId: string): void {
  stopInboxPolling();
  inboxPollOwner = canonicalId;
  inboxInitialPollDone = false;
  void pollInbox();
  inboxPollTimer = window.setInterval(() => {
    void pollInbox();
  }, INBOX_POLL_INTERVAL_MS);
}

function stopInboxPolling(): void {
  if (inboxPollTimer !== null) {
    window.clearInterval(inboxPollTimer);
    inboxPollTimer = null;
  }
  inboxPollOwner = null;
  inboxInitialPollDone = false;
}

async function pollInbox(): Promise<void> {
  if (inboxPollOwner === null) return;
  if (currentIdentityDocument === null) return;
  if (inboxPollOwner !== currentIdentityDocument.canonical_id) return;
  if (inboxPollInFlight) return;
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
  // Sender handle may be missing on stored row; surface it on the chat row
  // by upserting a contact entry so the chat list shows a real handle.
  for (const message of messages) {
    if (message.direction !== "received") continue;
    const handle = message.sender_handle ?? "";
    if (handle.length > 0) {
      try {
        await upsertContact({
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
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.13);
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

function describeAuthFailure(error: unknown): string {
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

  try {
    await withFlowTimeout(() => doSignup(handle, password));
  } catch (error) {
    setSignupState({ status: "error", message: describeAuthFailure(error) });
  } finally {
    signupBusy = false;
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
  setSignupState({ status: "created", identity, fingerprint, backupCode: "" });
  signupDialog.close();
  setSignedIn(identity.handle);
  flashFeedback("account created");
  setFeedTab("personal");
  // Best-effort device sync; never blocks signup completion.
  void syncCurrentDeviceToServer(trustedDevice).catch((error) => {
    console.warn("[auth] device sync after signup failed", error instanceof Error ? error.message : error);
    devicePanelFeedback.textContent = "device sync delayed; account created";
  });
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
    currentCryptoAccount = account;
    const fingerprint = await withStep("fingerprint", () => fingerprintPublicKey(getIdentityPublicKey(account.identity_document)), 5000);
    const identity = account.identity_document;
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
    setSignedIn(identity.handle);
    // signed-in landing pane is the personal feed; tab state is reset by setFeedTab.
    void syncCurrentDeviceToServer(buildTrustedDeviceRecord(identity, account, currentDeviceId!)).catch((error) => {
      console.warn("[auth] device sync after signin failed", error instanceof Error ? error.message : error);
    });
    return;
  } catch (error) {
    localUnlockError = error;
  }

  // Local-first unlock failed. Try the legacy dev sign-in path; map every
  // outcome to a user-readable message rather than a swallowed promise.
  try {
    const result = await withStep("dev-signin", () => signinDevHandle(handle, password));
    await withStep("write-dev-session", () => writeDevSessionToken(result.sessionToken));
    const fingerprint = await withStep("fingerprint", () => fingerprintPublicKey(getIdentityPublicKey(result.identity)), 5000);
    setCurrentIdentity(result.identity, fingerprint);
    setSigninState({ status: "signed_in", identity: result.identity });
    signinDialog.close();
    setSignedIn(result.identity.handle);
    // signed-in landing pane is the personal feed; tab state is reset by setFeedTab.
  } catch (devError) {
    throw new Error(explainSigninFailure(localUnlockError, devError));
  }
}

function explainSigninFailure(localError: unknown, devError: unknown): string {
  const localMessage = localError instanceof Error ? localError.message : "";
  const devMessage = devError instanceof Error ? devError.message : "";
  const localMissing = /stored account not found/i.test(localMessage);
  const looksLikeNetwork = /timeout|network|failed to fetch/i.test(devMessage);
  const looksLikeBadCredentials = /invalid|credentials|not found|wrong/i.test(devMessage);

  if (looksLikeNetwork) {
    return "network error. check your connection and try again.";
  }

  if (localMissing && looksLikeBadCredentials) {
    return "account not found on this device. restore or link this device.";
  }

  if (!localMissing) {
    return "wrong passphrase, or this account is on another device.";
  }

  return devMessage || localMessage || "sign-in failed";
}

async function runRecover(
  rawHandle: string,
  backupCode: string,
  recoveryQuestion: string,
  recoveryAnswer: string
): Promise<void> {
  const handle = normalizeLookupInput(rawHandle);
  if (handle.length === 0 || backupCode.trim().length === 0 || recoveryAnswer.trim().length === 0) {
    setSigninState({ status: "error", message: "handle, recovery code, and recovery answer are required" });
    return;
  }

  setSigninState({ status: "loading" });

  try {
    const result = await recoverDevHandle(
      handle,
      backupCode.trim(),
      recoveryQuestion,
      recoveryAnswer.trim()
    );
    // DEV ONLY: this browser session token is temporary scaffolding.
    // Production should bind sessions to device-held credentials.
    await writeDevSessionToken(result.sessionToken);
    const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(result.identity));
    setCurrentIdentity(result.identity, fingerprint);
    setSigninState({ status: "signed_in", identity: result.identity });
    setSignedIn(result.identity.handle);
    // signed-in landing pane is the personal feed; tab state is reset by setFeedTab.
  } catch (error) {
    setSigninState({
      status: "error",
      message: error instanceof Error ? error.message : "recovery failed",
    });
  }
}

async function submitRestoreAccount(): Promise<void> {
  if (restoreMode === "file") {
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
    return;
  }

  const handle = normalizeLookupInput(restoreHandleInput.value);
  const backupCode = restoreBackupCodeInput.value.trim();
  const recoveryAnswer = restoreAnswerInput.value.trim();
  if (handle.length === 0 || backupCode.length === 0 || recoveryAnswer.length === 0) {
    setRestoreState({ status: "error", message: "handle, recovery code, and recovery answer are required" });
    return;
  }

  setRestoreState({ status: "loading" });
  try {
    await runRecover(handle, backupCode, restoreQuestionInput.value, recoveryAnswer);
    restoreDialog.close();
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
}

async function restoreStoredSession(): Promise<void> {
  const sequence = ++authSequence;
  const token = await readDevSessionToken();
  if (token === null) {
    if (sequence === authSequence) setSignedOut();
    return;
  }

  try {
    const identity = await restoreDevSession(token);
    const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(identity));
    await saveIdentitySeen({
      canonical_id: identity.canonical_id,
      document: identity,
      seen_at: new Date().toISOString()
    });
    if (sequence !== authSequence) return;
    setCurrentIdentity(identity, fingerprint);
    setSignedIn(identity.handle);
  } catch {
    if (sequence !== authSequence) return;
    await clearDevSessionToken();
    setSignedOut();
  }
}

async function refreshLocalStorageStatus(): Promise<void> {
  const status = await getLocalStorageStatus();
  localStateStatus.textContent = `device status: ${status.messages} messages, ${status.contacts} contacts, ${status.events} events, ${status.pending_outbound} queued, ${status.trusted_devices} devices`;
  void refreshDevicePanel();
}

async function refreshDevicePanel(): Promise<void> {
  const metadata = await getLocalDeviceMetadata().catch(() => null);
  if (currentDeviceId === null && metadata !== null) {
    currentDeviceId = metadata.device_id;
  }

  const localDevices = await listTrustedDevices().catch(() => []);
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

async function syncCurrentDeviceToServer(device: import("./types.js").TrustedDevice): Promise<void> {
  if (currentIdentityDocument === null) return;

  try {
    await registerTrustedDevice(device);
    devicePanelFeedback.textContent = "device saved";
  } catch {
    devicePanelFeedback.textContent = "device saved locally";
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

async function startPairingFlow(): Promise<void> {
  if (currentIdentityDocument === null) {
    devicePanelFeedback.textContent = "sign in first";
    return;
  }

  try {
    const result = await startDevicePairing(currentIdentityDocument.canonical_id);
    activePairingCode = result.pairing_code;
    devicePairingCode.value = result.pairing_code;
    devicePanelFeedback.textContent = `pairing code ready: ${result.pairing_code}`;
    await refreshDevicePanel();
  } catch (error) {
    devicePanelFeedback.textContent = error instanceof Error ? error.message : "pairing start failed";
  }
}

async function completePairingFlow(): Promise<void> {
  if (currentIdentityDocument === null || currentCryptoAccount === null) {
    devicePanelFeedback.textContent = "unlock your account first";
    return;
  }

  const pairingCode = devicePairingCode.value.trim() || (activePairingCode ?? "");
  if (pairingCode.length === 0) {
    devicePanelFeedback.textContent = "enter a pairing code";
    return;
  }

  try {
    const deviceId = await ensureCurrentDeviceId();
    const device = buildTrustedDeviceRecord(currentIdentityDocument, currentCryptoAccount, deviceId);
    const payload = await createEncryptedBootstrapPayload(device, pairingCode);
    const result = await completeDevicePairing({
      pairing_code: pairingCode,
      device_id: device.device_id,
      name: device.name,
      device_public_key: device.device_public_key,
      encrypted_bootstrap_payload: payload
    });
    await saveTrustedDevice(result.device);
    await registerTrustedDevice(result.device);
    activePairingCode = null;
    devicePairingCode.value = "";
    devicePanelFeedback.textContent = "device linked";
    await refreshDevicePanel();
  } catch (error) {
    devicePanelFeedback.textContent = error instanceof Error ? error.message : "pairing complete failed";
  }
}

async function revokeDevice(deviceId: string): Promise<void> {
  if (currentIdentityDocument === null) {
    return;
  }

  try {
    const device = await revokeServerTrustedDevice(currentIdentityDocument.canonical_id, deviceId);
    await revokeTrustedDevice(device.device_id);
    devicePanelFeedback.textContent = "device revoked";
    await refreshDevicePanel();
  } catch (error) {
    devicePanelFeedback.textContent = error instanceof Error ? error.message : "device revoke failed";
  }
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

async function refreshFeedPosts(): Promise<void> {
  if (currentIdentityDocument === null) {
    renderStream(streamRoot);
    return;
  }

  try {
    const posts = await listUserFeedPosts(currentIdentityDocument.canonical_id, currentIdentityDocument.canonical_id);
    renderStream(streamRoot, posts);
  } catch {
    renderStream(streamRoot);
  }
}

async function refreshDiscoveryPosts(mode: DiscoveryMode = discoveryState.mode): Promise<void> {
  discoveryState = { status: "loading", mode };
  renderDiscoveryPanel(discoveryRoot, discoveryState, currentIdentityDocument?.canonical_id ?? null);

  try {
    const posts = await listDiscoveryPosts(mode, 20, 0);
    discoveryState = { status: "loaded", mode, posts };
  } catch (error) {
    discoveryState = {
      status: "error",
      mode,
      message: error instanceof Error ? error.message : "discovery load failed"
    };
  }

  renderDiscoveryPanel(discoveryRoot, discoveryState, currentIdentityDocument?.canonical_id ?? null);
}

async function setDiscoveryMode(mode: DiscoveryMode): Promise<void> {
  if (discoveryState.mode === mode && discoveryState.status === "loaded") {
    renderDiscoveryPanel(discoveryRoot, discoveryState, currentIdentityDocument?.canonical_id ?? null);
    return;
  }

  await refreshDiscoveryPosts(mode);
}

async function handleDiscoveryReaction(postId: string, reaction: string): Promise<void> {
  if (currentIdentityDocument === null) {
    flashFeedback("sign in to react");
    return;
  }

  if (!isDiscoveryReaction(reaction)) {
    return;
  }

  try {
    const reactionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const reactionType = reaction as "recommend" | "downrank" | "reply" | "repost" | "report";
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
            reaction: reactionType,
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
      reaction: reactionType,
      created_at: createdAt,
      signature
    });
    await refreshDiscoveryPosts(discoveryState.mode);
  } catch (error) {
    flashFeedback(error instanceof Error ? error.message : "reaction failed");
  }
}

async function handleLookupRelationshipAction(action: string): Promise<void> {
  if (currentIdentityDocument === null || lookupState.status !== "resolved") {
    return;
  }

  const ownerCanonicalId = currentIdentityDocument.canonical_id;
  const subjectCanonicalId = lookupState.identity.canonical_id;
  const handle = lookupState.identity.handle;

  try {
    if (action === "set-known") {
      await upsertConnectionRelationship({
        owner_canonical_id: ownerCanonicalId,
        subject_canonical_id: subjectCanonicalId,
        subject_handle: handle,
        tier: "known",
        subscribed: true
      });
    } else if (action === "set-close") {
      await upsertConnectionRelationship({
        owner_canonical_id: ownerCanonicalId,
        subject_canonical_id: subjectCanonicalId,
        subject_handle: handle,
        tier: "close",
        subscribed: true
      });
    } else if (action === "set-block") {
      await upsertConnectionRelationship({
        owner_canonical_id: ownerCanonicalId,
        subject_canonical_id: subjectCanonicalId,
        subject_handle: handle,
        tier: "blocked",
        subscribed: false
      });
    } else if (action === "set-unblock" || action === "set-unknown") {
      await deleteConnectionRelationship(ownerCanonicalId, subjectCanonicalId);
    } else if (action === "set-subscribe") {
      await upsertFeedSubscription({
        owner_canonical_id: ownerCanonicalId,
        author_canonical_id: subjectCanonicalId,
        author_handle: handle,
        include_public: true,
        include_connections: true,
        include_close: currentLookupRelationship?.tier === "close",
        muted: false
      });
    } else if (action === "set-unsubscribe") {
      await deleteFeedSubscription(ownerCanonicalId, subjectCanonicalId);
    }

    await refreshLookupRelationship();
    if (searchState.status === "results") {
      await runSearch(searchState.query);
    }
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
    feedComposerState.textContent = "posted";
    await refreshFeedPosts();
  } catch (error) {
    feedComposerState.textContent = error instanceof Error ? error.message : "post failed";
  }
}

async function lockLocalKeysFlow(): Promise<void> {
  lockBrowserCryptoAccount();
  currentCryptoAccount = null;
  flashFeedback("account locked");
  if (currentIdentityDocument !== null && currentIdentityFingerprint !== null) {
    setCurrentIdentity(currentIdentityDocument, currentIdentityFingerprint);
  }
}

async function exportEncryptedBackup(): Promise<void> {
  const passphrase = prompt("Backup passphrase. This never leaves this browser.");
  if (passphrase === null || passphrase.length === 0) {
    flashFeedback("backup cancelled");
    return;
  }

  try {
    const backup = await createEncryptedBackup(passphrase);
    const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sudo-backup-${backup.created_at.slice(0, 10)}.sudo-backup.json`;
    link.click();
    URL.revokeObjectURL(url);
    flashFeedback("encrypted backup exported");
  } catch (error) {
    flashFeedback(error instanceof Error ? error.message : "backup export failed");
  }
}

async function importSelectedBackup(file: File, passphrase: string): Promise<void> {
  try {
    const backup = JSON.parse(await file.text()) as EncryptedSudoBackup;
    await importEncryptedBackup(backup, passphrase);
    await refreshLocalChats();
    await refreshLocalStorageStatus();
    flashFeedback("encrypted backup imported");
  } catch {
    flashFeedback("backup import failed");
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
  currentIdentity = buildIdentityView(identity, fingerprint);
  renderIdentityPane(identityRoot, currentIdentity);
  void refreshDevicePanel();
  void refreshLookupRelationship();
  void refreshFeedPosts();
  renderDiscoveryPanel(discoveryRoot, discoveryState, currentIdentityDocument?.canonical_id ?? null);
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
    const enrichedResults = await enrichSearchResults(results);
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
  renderSearchResults(searchResultsRoot, searchState, getAddedCanonicals(), pendingAddedCanonicals, toggleChatTarget);
}

function toggleChatTarget(result: SearchResult): void {
  if (pendingAddedCanonicals.has(result.canonical)) {
    setSearchState(searchState);
    return;
  }

  if (getAddedCanonicals().has(result.canonical)) {
    void removeChatTarget(result);
    return;
  }

  void addChatTarget(result);
}

async function addChatTarget(result: SearchResult): Promise<void> {
  pendingAddedCanonicals.add(result.canonical);
  if (currentIdentityDocument !== null) {
    await upsertConnectionRelationship({
      owner_canonical_id: currentIdentityDocument.canonical_id,
      subject_canonical_id: result.canonical,
      subject_handle: result.handle,
      tier: "known",
      subscribed: true
    });
    await upsertFeedSubscription({
      owner_canonical_id: currentIdentityDocument.canonical_id,
      author_canonical_id: result.canonical,
      author_handle: result.handle,
      include_public: true,
      include_connections: true,
      include_close: false,
      muted: false
    });
  }
  await upsertContact({
    canonical_id: result.canonical,
    handle: result.handle,
    tier: "known",
    added_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    fingerprint: result.fingerprint
  }).then(refreshLocalStorageStatus);
  await refreshLocalChats();
  setSearchState(searchState);

  const existingTimer = pendingAddedTimers.get(result.canonical);
  if (existingTimer !== undefined) window.clearTimeout(existingTimer);
  pendingAddedTimers.set(result.canonical, window.setTimeout(() => {
    pendingAddedCanonicals.delete(result.canonical);
    pendingAddedTimers.delete(result.canonical);
    setSearchState(searchState);
  }, 2000));
}

async function removeChatTarget(result: SearchResult): Promise<void> {
  const canonical = result.canonical;
  const timer = pendingAddedTimers.get(canonical);
  if (timer !== undefined) window.clearTimeout(timer);
  pendingAddedTimers.delete(canonical);
  pendingAddedCanonicals.delete(canonical);
  if (currentIdentityDocument !== null) {
    await deleteConnectionRelationship(currentIdentityDocument.canonical_id, canonical);
    await deleteFeedSubscription(currentIdentityDocument.canonical_id, canonical);
  }
  await refreshLocalChats();
  setSearchState(searchState);
}

function getAddedCanonicals(): Set<string> {
  return new Set(localChats.map(getChatCanonical));
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
  setRestoreMode(restoreMode);
  restoreDialog.showModal();
  if (restoreMode === "file") {
    restoreFileInput.focus();
  } else {
    restoreHandleInput.focus();
  }
}

function setSignedIn(handle: string): void {
  authSequence++;
  setAuthView("signed-in");
  setAccountButtonHandle(handle);
  closeChatPopup();
  if (currentIdentityDocument !== null) {
    void refreshLocalChats();
    startInboxPolling(currentIdentityDocument.canonical_id);
  }
}

function setAccountButtonHandle(handle: string | null): void {
  if (handle === null || handle.length === 0) {
    accountButtonHandle.textContent = "";
    accountButton.removeAttribute("data-handle");
    accountMenuHandle.textContent = "";
    accountMenuFingerprint.textContent = "";
    return;
  }
  accountButtonHandle.textContent = handle;
  accountButton.setAttribute("data-handle", handle);
  accountMenuHandle.textContent = handle;
  accountMenuFingerprint.textContent = currentIdentityFingerprint
    ? `fingerprint ${currentIdentityFingerprint.slice(0, 12)}...`
    : "";
}

function setAccountMenuOpen(open: boolean): void {
  accountMenu.hidden = !open;
  accountButton.setAttribute("aria-expanded", open ? "true" : "false");
}

function openDevicesDialog(): void {
  void refreshDevicePanel();
  if (!devicesDialog.open) devicesDialog.showModal();
}

function setSignedOut(): void {
  authSequence++;
  stopInboxPolling();
  currentIdentityDocument = null;
  currentIdentityFingerprint = null;
  currentCryptoAccount = null;
  currentLookupRelationship = null;
  currentLookupSubscription = null;
  setAuthView("menu");
  currentIdentity = buildAnonymousIdentityView();
  renderIdentityPane(identityRoot, currentIdentity);
  localChats = [];
  renderChatList(chatsRoot, localChats);
  void refreshDevicePanel();
  renderDiscoveryPanel(discoveryRoot, discoveryState, null);
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
    renderDiscoveryPanel(discoveryRoot, discoveryState, null);
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
  if (currentIdentityDocument !== null && currentIdentityFingerprint !== null) {
    currentIdentity = buildIdentityView(currentIdentityDocument, currentIdentityFingerprint);
  } else {
    currentIdentity = buildAnonymousIdentityView();
  }

  renderIdentityPane(identityRoot, currentIdentity);
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
  void clearDevSessionToken().then(refreshLocalStorageStatus);
  clearSignupForm();
  clearSigninForm();
  clearRestoreForm();
  signupDialog.close();
  signinDialog.close();
  restoreDialog.close();
  setSignedOut();
}

function hideRecoveryPanel(): void {
  recoveryPanel.hidden = true;
  recoveryPanelSecret.textContent = "";
  backupCodeFeedback.textContent = "";
  recoveryAck.checked = false;
  syncRecoveryDismissState();
}

function showRecoveryPanel(backupCode: string): void {
  recoveryPanelSecret.textContent = backupCode;
  backupCodeFeedback.textContent = backupCode.length === 0
    ? "backup your account or copy your recovery information now"
    : "";
  recoveryPanel.hidden = false;
  recoveryAck.checked = false;
  syncRecoveryDismissState();
}

function syncRecoveryDismissState(): void {
  const isActive = recoveryAck.checked;
  recoveryDismiss.disabled = !isActive;
  recoveryDismiss.title = isActive ? "dismiss recovery code panel" : "check I saved this first";
}

async function copyBackupCode(): Promise<void> {
  const backupCode = recoveryPanelSecret.textContent ?? "";
  if (backupCode.length === 0) return;

  try {
    await navigator.clipboard?.writeText(backupCode);
    backupCodeFeedback.textContent = "copied";
    window.setTimeout(() => {
      if (backupCodeFeedback.textContent === "copied") backupCodeFeedback.textContent = "";
    }, 1800);
  } catch {
    selectBackupCode();
    backupCodeFeedback.textContent = "copy manually";
  }
}

function selectBackupCode(): void {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(recoveryPanelSecret);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function renderPasskeySupport(): void {
  const support = passkeyAccessProvider.isAvailable() ? "available" : "unavailable";
  signupPasskeySupport.textContent = `passkey support: ${support}`;
  signinPasskeySupport.textContent = `passkey support: ${support}`;
  // Recovery-answer / recovery-code restore is dev scaffolding only. Backup
  // file restore is the supported path today; say so plainly so users don't
  // submit a recovery answer expecting it to work.
  restorePasskeySupport.textContent = "restore by recovery answer is still a development path. use backup file restore.";
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
  restoreHandleInput.value = "";
  restoreBackupCodeInput.value = "";
  restoreAnswerInput.value = "";
  restorePassphraseInput.value = "";
  restoreFileInput.value = "";
  setRestoreMode("recovery");
  setRestoreState({ status: "idle" });
}

function setRestoreMode(mode: "recovery" | "file"): void {
  restoreMode = mode;
  restoreRecoveryFields.hidden = mode !== "recovery";
  restoreFileFields.hidden = mode !== "file";
  restoreModeRecovery.classList.toggle("is-active", mode === "recovery");
  restoreModeFile.classList.toggle("is-active", mode === "file");
  restoreSubmit.textContent = mode === "recovery" ? "restore account" : "restore from file";
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
  chatPopupFingerprint.textContent = target.fingerprint
    ? `fingerprint ${target.fingerprint.slice(0, 12)}...`
    : "";
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

async function renderChatPopupBody(canonicalId: string): Promise<void> {
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
  if (messages.length === 0) {
    chatPopupBody.replaceChildren(makeChatEmpty("no messages yet"));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    fragment.append(renderChatMessage(message));
  }
  chatPopupBody.replaceChildren(fragment);
  chatPopupBody.scrollTop = chatPopupBody.scrollHeight;
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
  const meta = document.createElement("div");
  meta.className = "chat-message__meta";
  const date = new Date(message.created_at);
  const time = Number.isNaN(date.valueOf()) ? message.created_at : date.toISOString().slice(11, 16);
  meta.textContent = `${time} ${message.direction === "sent" ? "you" : "them"}`;
  const body = document.createElement("div");
  body.className = "chat-message__body";
  body.textContent = message.body;
  wrapper.append(meta, body);
  return wrapper;
}

function conversationKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

async function listConversationMessages(conversationId: string): Promise<Array<{ message_id: string; created_at: string; direction: "sent" | "received"; body: string }>> {
  const records = await listLocalMessagesByConversation(conversationId);
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
    await renderChatPopupBody(target.canonical);
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


function isDiscoveryReaction(value: string): value is "recommend" | "downrank" | "reply" | "repost" | "report" {
  return value === "recommend"
    || value === "downrank"
    || value === "reply"
    || value === "repost"
    || value === "report";
}

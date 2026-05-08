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
  persistLocalChats,
  readDevSessionToken,
  readLocalChats,
  writeDevSessionToken
} from "./localState.js";
import { createEncryptedBackup, importEncryptedBackup, type EncryptedSudoBackup } from "./local/backup.js";
import { base64Url, randomBytes, deriveBackupKey, toBufferSource } from "./local/crypto.js";
import {
  clearLocalDb,
  getLocalStorageStatus,
  initializeLocalState,
  listCryptoAccounts,
  listTrustedDevices,
  getLocalDeviceMetadata,
  revokeTrustedDevice,
  saveIdentitySeen,
  saveTrustedDevice,
  upsertContact
} from "./local/local-store.js";
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

const shell = getRequiredElement("app-shell");
const identityRoot = getRequiredElement("identity-pane-body");
const streamRoot = getRequiredElement("stream-list");
const feedComposer = getRequiredForm("feed-composer");
const feedBodyInput = getRequiredTextArea("feed-body");
const feedVisibilityInput = getRequiredSelect("feed-visibility");
const feedTitleInput = getRequiredInput("feed-title");
const feedTagsInput = getRequiredInput("feed-tags");
const feedComposerState = getRequiredElement("feed-composer-state");
const lookupRoot = getRequiredElement("lookup-result");
const searchResultsRoot = getRequiredElement("search-results");
const chatsRoot = getRequiredElement("chat-list");
const discoveryRoot = getRequiredElement("discovery-list");
const searchForm = getRequiredForm("lookup-form");
const searchInput = getRequiredInput("lookup-input");
const headerHandle = getRequiredElement("header-handle");
const logoutButton = getRequiredButton("logout-button");
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
const cryptoAccountUnlock = getRequiredButton("crypto-account-unlock");
const cryptoAccountLock = getRequiredButton("crypto-account-lock");
const backupExport = getRequiredButton("backup-export");
const backupImport = getRequiredButton("backup-import");
const localStateClear = getRequiredButton("local-state-clear");
const localMaintenanceFeedback = getRequiredElement("local-maintenance-feedback");
const tabButtons = [...document.querySelectorAll("[data-tab-target]")];
const authActionButtons = [...document.querySelectorAll("[data-auth-action]")];
const headerAuthActionButtons = [...document.querySelectorAll(".header-auth [data-auth-action]")];
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
syncActivePane("stream");
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

backupExport.addEventListener("click", () => {
  void exportEncryptedBackup();
});

backupImport.addEventListener("click", () => {
  openRestoreDialog();
});

deviceLinkStart.addEventListener("click", () => {
  void startPairingFlow();
});

deviceLinkComplete.addEventListener("click", () => {
  void completePairingFlow();
});

cryptoAccountUnlock.addEventListener("click", () => {
  openSigninDialog();
});

cryptoAccountLock.addEventListener("click", () => {
  void lockLocalKeysFlow();
});

localStateClear.addEventListener("click", () => {
  void clearLocalStateWithConfirmation();
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

logoutButton.addEventListener("click", logout);

for (const button of tabButtons) {
  if (!(button instanceof HTMLButtonElement)) continue;
  button.addEventListener("click", () => {
    const target = button.dataset["tabTarget"];
    if (target === "identity" || target === "stream" || target === "chats" || target === "discovery") {
      syncActivePane(target);
    }
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "/" && event.target === document.body) {
    event.preventDefault();
    searchInput.focus();
  }
});

async function initializeLocalRuntime(): Promise<void> {
  try {
    await initializeLocalState();
    localChats = await readLocalChats();
    renderChatList(chatsRoot, localChats);
    await refreshLocalStorageStatus();
    await refreshDevicePanel();
  } catch (error) {
    localStateStatus.textContent = `device status: ${error instanceof Error ? error.message : "unavailable"}`;
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

async function runSignup(
  rawHandle: string,
  password: string,
  passwordConfirm: string,
  rawRecoveryAnswer: string
): Promise<void> {
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

  setSignupState({ status: "loading" });

  try {
    const nodeDocument = currentNodeDocument ?? await ensureNodeDocument().catch(() => null);
    const draft = await createBrowserCryptoAccount({
      handle,
      passphrase: password,
      homeNode: window.location.origin,
      deliveryRelays: nodeDocument?.relay_capabilities ?? []
    });
    const identity = await registerIdentityDocument(draft.identity_document);
    const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(identity));
    const deviceMetadata = await getLocalDeviceMetadata();
    const trustedDevice = buildTrustedDeviceRecord(identity, draft.account, deviceMetadata?.device_id ?? crypto.randomUUID());
    await saveIdentitySeen({
      canonical_id: identity.canonical_id,
      document: identity,
      seen_at: new Date().toISOString()
    });
    await storeBrowserCryptoAccount(draft.record);
    await saveTrustedDevice(trustedDevice);
    currentCryptoAccount = draft.account;
    currentDeviceId = trustedDevice.device_id;
    setCurrentIdentity(identity, fingerprint);
    setSignupState({ status: "created", identity, fingerprint, backupCode: "" });
    signupDialog.close();
    setSignedIn(identity.handle);
    localMaintenanceFeedback.textContent = "account created";
    syncActivePane("identity");
    showRecoveryPanel("");
    await syncCurrentDeviceToServer(trustedDevice);
  } catch (error) {
    setSignupState({
      status: "error",
      message: error instanceof Error ? error.message : "account creation failed",
    });
  }
}

function setSignupState(nextState: SignupState): void {
  signupState = nextState;
  renderSignupState(signupStateRoot, signupState);
}

async function runSignin(rawHandle: string, password: string): Promise<void> {
  const handle = normalizeLookupInput(rawHandle);
  if (handle.length === 0 || password.length === 0) {
    setSigninState({ status: "error", message: "handle and passphrase are required" });
    return;
  }

  setSigninState({ status: "loading" });

  try {
    const account = await unlockBrowserCryptoAccountByHandle(handle, password);
    currentCryptoAccount = account;
    const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(account.identity_document));
    const identity = account.identity_document;
    await saveIdentitySeen({
      canonical_id: identity.canonical_id,
      document: identity,
      seen_at: new Date().toISOString()
    });
    currentDeviceId = await ensureCurrentDeviceId();
    await saveTrustedDevice(buildTrustedDeviceRecord(identity, account, currentDeviceId));
    setCurrentIdentity(identity, fingerprint);
    setSigninState({ status: "signed_in", identity });
    signinDialog.close();
    setSignedIn(identity.handle);
    syncActivePane("identity");
    await syncCurrentDeviceToServer(buildTrustedDeviceRecord(identity, account, currentDeviceId));
  } catch (error) {
    try {
      const result = await signinDevHandle(handle, password);
      await writeDevSessionToken(result.sessionToken);
      const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(result.identity));
      setCurrentIdentity(result.identity, fingerprint);
      setSigninState({ status: "signed_in", identity: result.identity });
      signinDialog.close();
      setSignedIn(result.identity.handle);
      syncActivePane("identity");
      return;
    } catch (devError) {
      setSigninState({
        status: "error",
        message: error instanceof Error ? error.message : devError instanceof Error ? devError.message : "sign-in failed",
      });
    }
  }
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
    syncActivePane("identity");
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
      localMaintenanceFeedback.textContent = "backup restored";
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
  const metadata = await getLocalDeviceMetadata().catch(() => null);
  if (metadata !== null) {
    currentDeviceId = metadata.device_id;
    return metadata.device_id;
  }

  const deviceId = crypto.randomUUID();
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
    localMaintenanceFeedback.textContent = "sign in to react";
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
    localMaintenanceFeedback.textContent = error instanceof Error ? error.message : "reaction failed";
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
    localMaintenanceFeedback.textContent = error instanceof Error ? error.message : "relationship update failed";
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

  const visibility = feedVisibilityInput.value;
  if (!isFeedVisibility(visibility)) {
    feedComposerState.textContent = "invalid visibility";
    return;
  }

  const body = feedBodyInput.value.trim();
  const title = feedTitleInput.value.trim();
  const tags = feedTagsInput.value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  if (body.length === 0 && title.length === 0) {
    feedComposerState.textContent = "write a body or title";
    return;
  }

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
      ...(visibility === "public_metadata_encrypted_body"
        ? { encrypted_body: `dev-placeholder:${btoa(unescape(encodeURIComponent(body || title)))}` }
        : { body }),
      public_metadata: {
        title: title.length === 0 ? undefined : title,
        summary: visibility === "public_metadata_encrypted_body" && body.length > 0
          ? body.slice(0, 160)
          : undefined,
        tags
      },
      allowed_recipients: visibility === "close_connections"
        ? [currentIdentityDocument.canonical_id]
        : [],
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
      body: visibility === "public_metadata_encrypted_body" ? undefined : body,
      encrypted_body: visibility === "public_metadata_encrypted_body"
        ? `dev-placeholder:${btoa(unescape(encodeURIComponent(body || title)))}`
        : undefined,
      public_metadata: {
        title: title.length === 0 ? undefined : title,
        summary: visibility === "public_metadata_encrypted_body" && body.length > 0
          ? body.slice(0, 160)
          : undefined,
        tags
      },
      // DEV ONLY: until group keys exist, the composer posts close_connections
      // to the author's own canonical ID so the backend enforces an explicit list.
      allowed_recipients: visibility === "close_connections"
        ? [currentIdentityDocument.canonical_id]
        : undefined,
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null,
      sequence: 1,
      signature
    });
    feedBodyInput.value = "";
    feedTitleInput.value = "";
    feedTagsInput.value = "";
    feedComposerState.textContent = "posted";
    await refreshFeedPosts();
  } catch (error) {
    feedComposerState.textContent = error instanceof Error ? error.message : "post failed";
  }
}

async function lockLocalKeysFlow(): Promise<void> {
  lockBrowserCryptoAccount();
  currentCryptoAccount = null;
  localMaintenanceFeedback.textContent = "account locked";
  if (currentIdentityDocument !== null && currentIdentityFingerprint !== null) {
    setCurrentIdentity(currentIdentityDocument, currentIdentityFingerprint);
  }
}

async function exportEncryptedBackup(): Promise<void> {
  const passphrase = prompt("Backup passphrase. This never leaves this browser.");
  if (passphrase === null || passphrase.length === 0) {
    localMaintenanceFeedback.textContent = "backup cancelled";
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
    localMaintenanceFeedback.textContent = "encrypted backup exported";
  } catch (error) {
    localMaintenanceFeedback.textContent = error instanceof Error ? error.message : "backup export failed";
  }
}

async function importSelectedBackup(file: File, passphrase: string): Promise<void> {
  try {
    const backup = JSON.parse(await file.text()) as EncryptedSudoBackup;
    await importEncryptedBackup(backup, passphrase);
    localChats = await readLocalChats();
    renderChatList(chatsRoot, localChats);
    await refreshLocalStorageStatus();
    localMaintenanceFeedback.textContent = "encrypted backup imported";
  } catch {
    localMaintenanceFeedback.textContent = "backup import failed";
  }
}

async function clearLocalStateWithConfirmation(): Promise<void> {
  if (!confirm("Clear local sudo state on this device? Export an encrypted backup first.")) return;
  await clearLocalDb();
  localChats = [];
  renderChatList(chatsRoot, localChats);
  await initializeLocalState();
  await refreshLocalStorageStatus();
  localMaintenanceFeedback.textContent = "device reset";
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
  localChats = [
    {
      id: `local-${result.canonical}`,
      canonical: result.canonical,
      handle: result.handle,
      state: "draft",
      lastLine: "chat draft",
      fingerprint: result.fingerprint,
    },
    ...localChats,
  ];
  pendingAddedCanonicals.add(result.canonical);
  await persistLocalChats(localChats).then(refreshLocalStorageStatus);
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
  renderChatList(chatsRoot, localChats);
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
  localChats = localChats.filter((chat) => getChatCanonical(chat) !== canonical);
  await persistLocalChats(localChats).then(refreshLocalStorageStatus);
  if (currentIdentityDocument !== null) {
    await deleteConnectionRelationship(currentIdentityDocument.canonical_id, canonical);
    await deleteFeedSubscription(currentIdentityDocument.canonical_id, canonical);
  }
  renderChatList(chatsRoot, localChats);
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
  headerHandle.textContent = handle;
  logoutButton.hidden = false;
  for (const button of headerAuthActionButtons) {
    if (button instanceof HTMLButtonElement) button.hidden = true;
  }
}

function setSignedOut(): void {
  authSequence++;
  currentIdentityDocument = null;
  currentIdentityFingerprint = null;
  currentCryptoAccount = null;
  currentLookupRelationship = null;
  currentLookupSubscription = null;
  setAuthView("menu");
  currentIdentity = buildAnonymousIdentityView();
  renderIdentityPane(identityRoot, currentIdentity);
  void refreshDevicePanel();
  renderDiscoveryPanel(discoveryRoot, discoveryState, null);
  headerHandle.textContent = "";
  logoutButton.hidden = true;
  for (const button of headerAuthActionButtons) {
    if (button instanceof HTMLButtonElement) button.hidden = false;
  }
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
  restorePasskeySupport.textContent = `restore answer path: ${support}`;
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

function syncActivePane(pane: "identity" | "stream" | "chats" | "discovery"): void {
  shell.dataset["activePane"] = pane;

  for (const button of tabButtons) {
    if (!(button instanceof HTMLButtonElement)) continue;
    const isActive = button.dataset["tabTarget"] === pane;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
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

function isFeedVisibility(value: string): value is "connections_only" | "close_connections" | "unlisted" | "public" | "public_metadata_encrypted_body" {
  return value === "connections_only"
    || value === "close_connections"
    || value === "unlisted"
    || value === "public"
    || value === "public_metadata_encrypted_body";
}

function isDiscoveryReaction(value: string): value is "recommend" | "downrank" | "reply" | "repost" | "report" {
  return value === "recommend"
    || value === "downrank"
    || value === "reply"
    || value === "repost"
    || value === "report";
}

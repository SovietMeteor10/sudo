import { localIdentity } from "./data.js";
import { BrowserPasskeyAccessProvider } from "./accessProviders.js";
import {
  fingerprintPublicKey,
  lookupHandle,
  normalizeLookupInput,
  recoverDevHandle,
  restoreDevSession,
  searchHandles,
  signinDevHandle,
  signupDevHandle
} from "./api.js";
import {
  renderChatList,
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
import {
  clearLocalDb,
  getLocalStorageStatus,
  initializeLocalState,
  saveIdentitySeen,
  upsertContact
} from "./local/local-store.js";
import type { ChatSummary, IdentityDocument, LocalIdentity, SearchResult, SearchState, SigninState, LookupState, SignupState } from "./types.js";

const shell = getRequiredElement("app-shell");
const identityRoot = getRequiredElement("identity-pane-body");
const streamRoot = getRequiredElement("stream-list");
const lookupRoot = getRequiredElement("lookup-result");
const searchResultsRoot = getRequiredElement("search-results");
const chatsRoot = getRequiredElement("chat-list");
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
const signupRecoveryPromptInput = getRequiredSelect("signup-recovery-prompt");
const signupRecoveryPhraseInput = getRequiredInput("signup-recovery-phrase");
const signupStateRoot = getRequiredElement("signup-state");
const signupPasskeySupport = getRequiredElement("signup-passkey-support");
const signinCancel = getRequiredButton("signin-cancel");
const signinDialog = getRequiredDialog("signin-dialog");
const signinForm = getRequiredForm("signin-form");
const signinPasswordFields = getRequiredElement("signin-password-fields");
const signinRecoveryFields = getRequiredElement("signin-recovery-fields");
const signinHandleInput = getRequiredInput("signin-handle");
const signinPasswordInput = getRequiredInput("signin-password");
const signinRecoverMode = getRequiredButton("signin-recover-mode");
const signinPasswordMode = getRequiredButton("signin-password-mode");
const recoverHandleInput = getRequiredInput("recover-handle");
const recoverBackupCodeInput = getRequiredInput("recover-backup-code");
const recoverQuestionInput = getRequiredSelect("recover-question");
const recoverAnswerInput = getRequiredInput("recover-answer");
const signinStateRoot = getRequiredElement("signin-state");
const signinPasskeySupport = getRequiredElement("signin-passkey-support");
const signinSubmit = getRequiredButton("signin-submit");
const recoveryPanel = getRequiredElement("recovery-panel");
const recoveryPanelSecret = getRequiredElement("recovery-panel-secret");
const backupCodeCopy = getRequiredButton("backup-code-copy");
const backupCodeFeedback = getRequiredElement("backup-code-feedback");
const recoveryAck = getRequiredInput("recovery-ack");
const recoveryDismiss = getRequiredButton("recovery-dismiss");
const localStateStatus = getRequiredElement("local-storage-status");
const backupExport = getRequiredButton("backup-export");
const backupImport = getRequiredButton("backup-import");
const backupImportFile = getRequiredInput("backup-import-file");
const localStateClear = getRequiredButton("local-state-clear");
const localMaintenanceFeedback = getRequiredElement("local-maintenance-feedback");
const tabButtons = [...document.querySelectorAll("[data-tab-target]")];
const authActionButtons = [...document.querySelectorAll("[data-auth-action]")];
const headerAuthActionButtons = [...document.querySelectorAll(".header-auth [data-auth-action]")];

const passkeyAccessProvider = new BrowserPasskeyAccessProvider();

let lookupState: LookupState = { status: "idle" };
let signupState: SignupState = { status: "idle" };
let signinState: SigninState = { status: "idle" };
let searchState: SearchState = { status: "idle" };
let currentIdentity: LocalIdentity = localIdentity;
let localChats: ChatSummary[] = [];
const pendingAddedCanonicals = new Set<string>();
const pendingAddedTimers = new Map<string, number>();
let activeLookup: AbortController | null = null;
let activeSearch: AbortController | null = null;
let searchDebounce: number | null = null;
let authSequence = 0;
let signinMode: "password" | "recovery" = "password";

renderIdentityPane(identityRoot, currentIdentity);
renderLookupResult(lookupRoot, lookupState);
renderSignupState(signupStateRoot, signupState);
renderSigninState(signinStateRoot, signinState);
renderChatList(chatsRoot, localChats);
renderSearchResults(searchResultsRoot, searchState, getAddedCanonicals(), pendingAddedCanonicals, toggleChatTarget);
renderPasskeySupport();
syncActivePane("stream");
void initializeLocalRuntime();
void renderStreamWhenReady();
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

signupCancel.addEventListener("click", () => {
  signupDialog.close();
});

signupDialog.addEventListener("close", clearSignupForm);

signupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runSignup(
    signupInput.value,
    signupPasswordInput.value,
    signupPasswordConfirmInput.value,
    signupRecoveryPhraseInput.value
  );
});

signinCancel.addEventListener("click", () => {
  signinDialog.close();
});

signinDialog.addEventListener("close", clearSigninForm);

signinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (signinMode === "password") {
    void runSignin(signinHandleInput.value, signinPasswordInput.value);
  } else {
    void runRecover(
      recoverHandleInput.value,
      recoverBackupCodeInput.value,
      recoverQuestionInput.value,
      recoverAnswerInput.value
    );
  }
});

signinRecoverMode.addEventListener("click", () => setSigninMode("recovery"));
signinPasswordMode.addEventListener("click", () => setSigninMode("password"));

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
  backupImportFile.click();
});

backupImportFile.addEventListener("change", () => {
  void importSelectedBackup();
});

localStateClear.addEventListener("click", () => {
  void clearLocalStateWithConfirmation();
});

for (const button of authActionButtons) {
  if (!(button instanceof HTMLButtonElement)) continue;
  button.addEventListener("click", () => {
    if (button.dataset["authAction"] === "signup") {
      openSignupDialog();
    } else {
      openSigninDialog();
    }
  });
}

logoutButton.addEventListener("click", logout);

for (const button of tabButtons) {
  if (!(button instanceof HTMLButtonElement)) continue;
  button.addEventListener("click", () => {
    const target = button.dataset["tabTarget"];
    if (target === "identity" || target === "stream" || target === "chats") {
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
  } catch (error) {
    localStateStatus.textContent = `local storage: ${error instanceof Error ? error.message : "unavailable"}`;
  }
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
    if (controller.signal.aborted) return;
    setLookupState({ status: "resolved", query, identity, fingerprint });
  } catch (error) {
    if (controller.signal.aborted) return;
    setLookupState({
      status: "error",
      query,
      message: error instanceof Error ? error.message : "lookup failed",
    });
  }
}

function setLookupState(nextState: LookupState): void {
  lookupState = nextState;
  renderLookupResult(lookupRoot, lookupState);
}

async function runSignup(
  rawHandle: string,
  password: string,
  passwordConfirm: string,
  rawRecoveryAnswer: string
): Promise<void> {
  const handle = normalizeLookupInput(rawHandle);
  const recoveryAnswer = rawRecoveryAnswer.trim();
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
      message: "passwords do not match",
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

  if (recoveryAnswer.length < 1) {
    setSignupState({
      status: "error",
      message: "choose a recovery question and answer",
    });
    return;
  }

  setSignupState({ status: "loading" });

  try {
    const result = await signupDevHandle(handle, password, signupRecoveryPromptInput.value, recoveryAnswer);
    const identity = result.identity;
    const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(identity));
    await saveIdentitySeen({
      canonical_id: identity.canonical_id,
      document: identity,
      seen_at: new Date().toISOString()
    });
    setCurrentIdentity(identity, fingerprint);
    setSignupState({ status: "created", identity, fingerprint, backupCode: result.backupCode });
    // DEV ONLY: this browser IndexedDB session token is temporary scaffolding.
    // Production should bind sessions to device-held credentials.
    await writeDevSessionToken(result.sessionToken);
    signupDialog.close();
    setSignedIn(identity.handle);
    showRecoveryPanel(result.backupCode);
    syncActivePane("identity");
  } catch (error) {
    setSignupState({
      status: "error",
      message: error instanceof Error ? error.message : "signup failed",
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
    setSigninState({ status: "error", message: "handle and password are required" });
    return;
  }

  setSigninState({ status: "loading" });

  try {
    const result = await signinDevHandle(handle, password);
    // DEV ONLY: this browser IndexedDB session token is temporary scaffolding.
    // Production should bind sessions to device-held credentials.
    await writeDevSessionToken(result.sessionToken);
    const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(result.identity));
    setCurrentIdentity(result.identity, fingerprint);
    setSigninState({ status: "signed_in", identity: result.identity });
    signinDialog.close();
    setSignedIn(result.identity.handle);
    syncActivePane("identity");
  } catch (error) {
    setSigninState({
      status: "error",
      message: error instanceof Error ? error.message : "sign-in failed",
    });
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
    setSigninState({ status: "error", message: "handle, backup code, and recovery answer are required" });
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
    // DEV ONLY: this browser IndexedDB session token is temporary scaffolding.
    // Production should bind sessions to device-held credentials.
    await writeDevSessionToken(result.sessionToken);
    const fingerprint = await fingerprintPublicKey(getIdentityPublicKey(result.identity));
    setCurrentIdentity(result.identity, fingerprint);
    setSigninState({ status: "signed_in", identity: result.identity });
    signinDialog.close();
    setSignedIn(result.identity.handle);
    syncActivePane("identity");
  } catch (error) {
    setSigninState({
      status: "error",
      message: error instanceof Error ? error.message : "recovery failed",
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
  localStateStatus.textContent = `local storage: ${status.messages} messages, ${status.contacts} contacts, ${status.events} events, ${status.pending_outbound} queued`;
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

async function importSelectedBackup(): Promise<void> {
  const file = backupImportFile.files?.[0];
  backupImportFile.value = "";
  if (file === undefined) return;

  const passphrase = prompt("Backup passphrase. This never leaves this browser.");
  if (passphrase === null || passphrase.length === 0) {
    localMaintenanceFeedback.textContent = "import cancelled";
    return;
  }

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
  localMaintenanceFeedback.textContent = "local state cleared";
}

function setCurrentIdentity(identity: IdentityDocument, fingerprint: string): void {
  currentIdentity = {
    handle: identity.handle,
    bio: "local-dev identity",
    status: "quiet",
    privacyMode: "ghost mode: off",
    onionState: "onion: local only",
    fingerprintSnippet: `${fingerprint.slice(0, 4)}...`,
  };
  renderIdentityPane(identityRoot, currentIdentity);
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
    if (controller.signal.aborted) return;
    setSearchState({ status: "results", query, results });
  } catch (error) {
    if (controller.signal.aborted) return;
    setSearchState({
      status: "error",
      query,
      message: error instanceof Error ? error.message : "search failed",
    });
  }
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
    removeChatTarget(result.canonical);
    return;
  }

  addChatTarget(result);
}

function addChatTarget(result: SearchResult): void {
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
  void persistLocalChats(localChats).then(refreshLocalStorageStatus);
  void upsertContact({
    canonical_id: result.canonical,
    handle: result.handle,
    tier: "unknown",
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

function removeChatTarget(canonical: string): void {
  const timer = pendingAddedTimers.get(canonical);
  if (timer !== undefined) window.clearTimeout(timer);
  pendingAddedTimers.delete(canonical);
  pendingAddedCanonicals.delete(canonical);
  localChats = localChats.filter((chat) => getChatCanonical(chat) !== canonical);
  void persistLocalChats(localChats).then(refreshLocalStorageStatus);
  renderChatList(chatsRoot, localChats);
  setSearchState(searchState);
}

function getAddedCanonicals(): Set<string> {
  return new Set(localChats.map(getChatCanonical));
}

function getChatCanonical(chat: ChatSummary): string {
  return chat.canonical ?? chat.id;
}

function openSignupDialog(): void {
  setSignupState({ status: "idle" });
  clearSignupForm();
  signupDialog.showModal();
  signupInput.focus();
}

function openSigninDialog(): void {
  setSigninState({ status: "idle" });
  clearSigninForm();
  setSigninMode("password");
  signinDialog.showModal();
  signinHandleInput.focus();
}

function setSignedIn(handle: string): void {
  authSequence++;
  document.body.dataset["authState"] = "signed-in";
  headerHandle.textContent = handle;
  logoutButton.hidden = false;
  for (const button of headerAuthActionButtons) {
    if (button instanceof HTMLButtonElement) button.hidden = true;
  }
}

function setSignedOut(): void {
  authSequence++;
  document.body.dataset["authState"] = "signed-out";
  currentIdentity = localIdentity;
  renderIdentityPane(identityRoot, currentIdentity);
  headerHandle.textContent = "";
  logoutButton.hidden = true;
  for (const button of headerAuthActionButtons) {
    if (button instanceof HTMLButtonElement) button.hidden = false;
  }
}

function logout(): void {
  void clearDevSessionToken().then(refreshLocalStorageStatus);
  clearSignupForm();
  clearSigninForm();
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
  backupCodeFeedback.textContent = "";
  recoveryPanel.hidden = false;
  recoveryAck.checked = false;
  syncRecoveryDismissState();
}

function syncRecoveryDismissState(): void {
  const isActive = recoveryAck.checked;
  recoveryDismiss.disabled = !isActive;
  recoveryDismiss.title = isActive ? "dismiss backup code panel" : "check I saved this first";
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
}

function clearSignupForm(): void {
  signupForm.reset();
  signupInput.value = "";
  signupPasswordInput.value = "";
  signupPasswordConfirmInput.value = "";
  signupRecoveryPhraseInput.value = "";
  setSignupState({ status: "idle" });
}

function clearSigninForm(): void {
  signinForm.reset();
  signinHandleInput.value = "";
  signinPasswordInput.value = "";
  recoverHandleInput.value = "";
  recoverBackupCodeInput.value = "";
  recoverAnswerInput.value = "";
  if (signinMode !== "password") setSigninMode("password");
  setSigninState({ status: "idle" });
}

function setSigninMode(mode: "password" | "recovery"): void {
  signinMode = mode;
  signinPasswordFields.hidden = mode !== "password";
  signinRecoveryFields.hidden = mode !== "recovery";
  signinSubmit.textContent = mode === "password" ? "sign in" : "recover";
  signinHandleInput.value = "";
  signinPasswordInput.value = "";
  recoverHandleInput.value = "";
  recoverBackupCodeInput.value = "";
  recoverAnswerInput.value = "";
  setSigninState({ status: "idle" });
  if (mode === "password") {
    signinHandleInput.focus();
  } else {
    recoverHandleInput.focus();
  }
}

function validatePassword(password: string): string | null {
  if (password.length < 12) return "password must be at least 12 characters";
  if (!/[A-Z]/.test(password)) return "password needs an uppercase letter";
  if (!/[a-z]/.test(password)) return "password needs a lowercase letter";
  if (!/[0-9]/.test(password)) return "password needs a number";
  if (!/[^A-Za-z0-9]/.test(password)) return "password needs a symbol";
  return null;
}

function syncActivePane(pane: "identity" | "stream" | "chats"): void {
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

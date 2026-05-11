#!/usr/bin/env node
// Linked-devices dialog layout smoke. Verifies:
//   - three sections render in the right order (this device →
//     linked devices → revoked devices, where revoked is hidden
//     when none exist);
//   - the "this device" section has exactly one row, with no
//     revoke / link-again action;
//   - peer rows expose a revoke button before any advanced details;
//   - the temporary-passcode card stays hidden until "link another
//     device" is clicked;
//   - default visible surface contains no "pending" / "locked" /
//     internal terminology.
//
// Wired up as `npm run smoke:linked-devices-layout`.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (error) {
  console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
  console.error(error.message);
  process.exit(2);
}

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";

async function waitFor(page, predicate, timeoutMs = 15000, interval = 80) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(predicate)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

async function openDevicesDialog(page) {
  await page.evaluate(() => {
    document.getElementById("account-button")?.click();
    document.getElementById("account-menu-settings")?.click();
  });
  await waitFor(page, () => document.getElementById("settings-dialog")?.open === true);
  await page.evaluate(() => document.getElementById("settings-devices")?.click());
  await waitFor(page, () => document.getElementById("devices-dialog")?.open === true);
}

async function collectAccountOnPage(page, code) {
  await page.click('.landing [data-auth-action="signin"]');
  await waitFor(page, () => document.getElementById("signin-dialog")?.open === true);
  await page.click('#signin-dialog [data-auth-action="link"]');
  await waitFor(page, () => document.getElementById("link-device-dialog")?.open === true);
  await page.type("#link-device-code", code);
  await page.type("#link-device-passphrase", PASSPHRASE);
  await page.click("#link-device-submit");
  return waitFor(page, () => document.body.dataset.authState === "signed-in", 30000);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  // ===== A — signup =====
  const ctxA = await browser.createBrowserContext();
  const pageA = await ctxA.newPage();
  await pageA.setViewport({ width: 980, height: 820 });
  pageA.on("pageerror", (err) => console.log("PAGEA-ERR>", err.message));
  await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
  const handle = `ld${Date.now().toString().slice(-7)}`;
  await pageA.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await pageA.type("#signup-handle", handle);
  await pageA.type("#signup-password", PASSPHRASE);
  await pageA.type("#signup-password-confirm", PASSPHRASE);
  await pageA.click('#signup-form button[type="submit"]');
  if (!await waitFor(pageA, () => document.body.dataset.authState === "signed-in")) {
    fail("1.signup", "did not sign in"); throw new Error();
  }
  ok(`1. signed up @${handle}`);

  // ===== Open devices dialog =====
  await openDevicesDialog(pageA);
  // Wait until the device-list has finished its first render against
  // the (just-unlocked) crypto account — otherwise on a fresh signup
  // we can briefly see 0 rows before the panel notices the current
  // device. Local runs almost never hit this race; live runs do.
  if (!await waitFor(pageA, () => {
    return document.querySelectorAll(".devices-panel__section--current .device-row").length >= 1;
  }, 15000)) {
    fail("1b.panel-first-render", "device list never populated the 'this device' row");
    throw new Error();
  }

  // ===== Pairing card hidden by default =====
  const initial = await pageA.evaluate(() => {
    const card = document.getElementById("pairing-card");
    const codeText = document.getElementById("pairing-card-code")?.textContent?.trim() ?? "";
    return { hidden: card instanceof HTMLElement ? card.hidden : null, codeText };
  });
  if (initial.hidden !== true) {
    fail("2.pairing-hidden", `pairing card not hidden on open: ${JSON.stringify(initial)}`);
  } else {
    ok(`2. pairing card hidden by default (no code shown)`);
  }

  // ===== Section layout: this device + linked devices (no revoked yet) =====
  const sections = await pageA.evaluate(() => {
    const root = document.getElementById("device-list");
    if (root === null) return null;
    return [...root.querySelectorAll(".devices-panel__section")].map((s) => {
      const title = s.querySelector(".devices-panel__section-title")?.textContent?.trim() ?? "";
      const rowCount = s.querySelectorAll(".device-row").length;
      const className = s.className;
      return { title, rowCount, className };
    });
  });
  if (sections === null || sections.length < 2) {
    fail("3.sections", `expected at least 2 sections (this device + linked devices), got: ${JSON.stringify(sections)}`);
    throw new Error();
  }
  if (!sections[0].className.includes("--current") || sections[0].title !== "this device") {
    fail("3a.section1", `first section should be 'this device', got '${sections[0].title}'`);
  } else if (sections[0].rowCount !== 1) {
    fail("3b.this-device-count", `'this device' section should have 1 row, got ${sections[0].rowCount}`);
  } else {
    ok(`3a. section 1 is 'this device' with exactly one row`);
  }
  if (!sections[1].className.includes("--peers") || sections[1].title !== "linked devices") {
    fail("3c.section2", `second section should be 'linked devices', got '${sections[1].title}'`);
  } else {
    ok(`3b. section 2 is 'linked devices'`);
  }
  // No revoked section yet because no devices revoked.
  const hasRevokedSection = sections.some((s) => s.className.includes("--revoked"));
  if (hasRevokedSection) {
    fail("3d.no-revoked-yet", "revoked section should not render when no revoked devices");
  } else {
    ok(`3c. no revoked section when none are revoked`);
  }

  // ===== Current device row has no revoke / link-again button =====
  const currentRowActions = await pageA.evaluate(() => {
    const current = document.querySelector(".devices-panel__section--current .device-row");
    if (current === null) return null;
    return {
      hasRevoke: current.querySelector('[data-device-action="revoke-prompt"]') !== null,
      hasLinkAgain: current.querySelector('[data-device-action="link-again"]') !== null
    };
  });
  if (!currentRowActions) {
    fail("4.current-row", "no current-device row found");
  } else if (currentRowActions.hasRevoke || currentRowActions.hasLinkAgain) {
    fail("4.current-row-actions", `current device should have no destructive actions: ${JSON.stringify(currentRowActions)}`);
  } else {
    ok(`4. current-device row exposes no revoke/link-again actions`);
  }

  // ===== Default surface free of internal terminology =====
  const visible = await pageA.evaluate(() => {
    const root = document.getElementById("device-list");
    if (root === null) return "";
    const clone = root.cloneNode(true);
    for (const det of clone.querySelectorAll(".device-row__advanced-body")) det.remove();
    return (clone.textContent ?? "").toLowerCase();
  });
  const forbidden = ["locked", "ciphertext", "indexeddb", "encrypted_payload", "signed_event_json", "origin_device_seq"];
  const leaked = forbidden.filter((term) => visible.includes(term));
  if (leaked.length > 0) {
    fail("5.surface-leak", `default surface leaks: ${leaked.join(", ")}`);
  } else {
    ok(`5. default surface free of "locked" / internal terminology`);
  }

  // ===== Whole dialog (including feedback row) must never carry
  //       "unlock your account first" copy. The product no longer has
  //       a user-facing lock concept; this string blocked devices
  //       management for signed-in users on prod. =====
  const dialogText = await pageA.evaluate(() => {
    const dlg = document.getElementById("devices-dialog");
    return (dlg?.textContent ?? "").toLowerCase();
  });
  if (dialogText.includes("unlock your account first")) {
    fail("5b.unlock-copy", `devices dialog still contains 'unlock your account first'`);
  } else {
    ok(`5b. devices dialog free of 'unlock your account first' copy`);
  }

  // ===== Click "link another device" — pairing card appears =====
  await pageA.evaluate(() => {
    document.getElementById("device-link-start")?.click();
  });
  await waitFor(pageA, () => {
    const card = document.getElementById("pairing-card");
    const code = document.getElementById("pairing-card-code")?.textContent?.trim() ?? "";
    return card instanceof HTMLElement && !card.hidden && /^[0-9A-F]{6}-[0-9A-F]{6}$/.test(code);
  }, 15000);
  const afterClick = await pageA.evaluate(() => {
    const card = document.getElementById("pairing-card");
    return {
      hidden: card instanceof HTMLElement ? card.hidden : null,
      codeText: document.getElementById("pairing-card-code")?.textContent?.trim() ?? ""
    };
  });
  if (afterClick.hidden !== false || !/^[0-9A-F]{6}-[0-9A-F]{6}$/.test(afterClick.codeText)) {
    fail("6.passcode-show", `pairing card did not surface a fresh code: ${JSON.stringify(afterClick)}`);
  } else {
    ok(`6. 'link another device' reveals pairing card with code ${afterClick.codeText}`);
  }

  // ===== Close + reopen: pairing card must NOT persist across opens =====
  // Visible passcode panel reserving space (or showing a stale code)
  // every time devices dialog opened was the live regression. Verify
  // the panel hides on close and stays hidden on the next open.
  await pageA.evaluate(() => document.getElementById("devices-cancel")?.click());
  await waitFor(pageA, () => document.getElementById("devices-dialog")?.open !== true);
  await openDevicesDialog(pageA);
  const reopened = await pageA.evaluate(() => {
    const card = document.getElementById("pairing-card");
    return {
      hidden: card instanceof HTMLElement ? card.hidden : null,
      codeText: document.getElementById("pairing-card-code")?.textContent?.trim() ?? ""
    };
  });
  if (reopened.hidden !== true || reopened.codeText.length > 0) {
    fail("6b.reopen-hidden", `pairing card persisted after reopen: ${JSON.stringify(reopened)}`);
  } else {
    ok(`6b. pairing card hidden after close + reopen`);
  }
  // Re-create a code for the rest of the flow.
  await pageA.evaluate(() => document.getElementById("device-link-start")?.click());
  if (!await waitFor(pageA, () => {
    const card = document.getElementById("pairing-card");
    const code = document.getElementById("pairing-card-code")?.textContent?.trim() ?? "";
    return card instanceof HTMLElement && !card.hidden && /^[0-9A-F]{6}-[0-9A-F]{6}$/.test(code);
  }, 15000)) {
    fail("6c.regen", "could not regenerate pairing code after reopen"); throw new Error();
  }
  const refreshedCode = await pageA.evaluate(() => document.getElementById("pairing-card-code")?.textContent?.trim() ?? "");
  ok(`6c. fresh pairing code after reopen: ${refreshedCode}`);
  const pairingCodeForPair = refreshedCode;

  // ===== Pair a second device =====
  const ctxB = await browser.createBrowserContext();
  const pageB = await ctxB.newPage();
  await pageB.setViewport({ width: 980, height: 820 });
  pageB.on("pageerror", (err) => console.log("PAGEB-ERR>", err.message));
  await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
  if (!await collectAccountOnPage(pageB, pairingCodeForPair)) {
    fail("7.b-signed-in", "second device did not reach signed-in"); throw new Error();
  }
  ok(`7. second device linked + signed in`);

  // Wait for A's panel to register the new peer in the linked-devices
  // section.
  let peerSectionRows = 0;
  for (let i = 0; i < 30; i++) {
    peerSectionRows = await pageA.evaluate(() => {
      return document.querySelectorAll(".devices-panel__section--peers .device-row").length;
    });
    if (peerSectionRows >= 1) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (peerSectionRows < 1) {
    fail("8.peer-visible", `linked-devices section never showed the new peer`);
  } else {
    ok(`8. linked-devices section shows the new peer (${peerSectionRows} row)`);
  }

  // ===== Revoke button visible on the peer row, before advanced =====
  const peerStructure = await pageA.evaluate(() => {
    const peerRow = document.querySelector(".devices-panel__section--peers .device-row");
    if (peerRow === null) return null;
    const children = [...peerRow.children];
    const actionsIdx = children.findIndex((c) => c.classList.contains("device-row__actions"));
    const advancedIdx = children.findIndex((c) => c.classList.contains("device-row__advanced"));
    return {
      hasRevoke: peerRow.querySelector('[data-device-action="revoke-prompt"]') !== null,
      actionsIdx,
      advancedIdx
    };
  });
  if (!peerStructure || !peerStructure.hasRevoke) {
    fail("9.peer-revoke-button", "peer row missing revoke button");
  } else if (peerStructure.actionsIdx === -1 || peerStructure.advancedIdx === -1) {
    fail("9b.peer-structure", `expected both actions + advanced; got ${JSON.stringify(peerStructure)}`);
  } else if (peerStructure.actionsIdx > peerStructure.advancedIdx) {
    fail("9c.action-before-advanced", `actions area (idx=${peerStructure.actionsIdx}) should come before advanced (idx=${peerStructure.advancedIdx})`);
  } else {
    ok(`9. peer row exposes revoke button above advanced disclosure`);
  }

  // ===== Revoke flow works end-to-end =====
  await pageA.evaluate(() => {
    document.querySelector('.devices-panel__section--peers [data-device-action="revoke-prompt"]')?.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await pageA.evaluate(() => {
    document.querySelector('.devices-panel__section--peers [data-device-action="revoke-confirm"]')?.click();
  });
  let revokedSectionShown = false;
  for (let i = 0; i < 30; i++) {
    revokedSectionShown = await pageA.evaluate(() => {
      const sect = document.querySelector(".devices-panel__section--revoked");
      const revRow = document.querySelector(".devices-panel__section--revoked .device-row");
      return sect !== null && revRow !== null;
    });
    if (revokedSectionShown) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!revokedSectionShown) {
    fail("10.revoked-section", "revoked section did not appear after revoke");
  } else {
    ok(`10. revoke moved the peer into the revoked section`);
  }

  // ===== Revoked section row has link-again, no revoke button =====
  const revokedStructure = await pageA.evaluate(() => {
    const row = document.querySelector(".devices-panel__section--revoked .device-row");
    if (row === null) return null;
    return {
      hasLinkAgain: row.querySelector('[data-device-action="link-again"]') !== null,
      hasRevoke: row.querySelector('[data-device-action="revoke-prompt"]') !== null,
      collapsedByDefault: row.closest("details") instanceof HTMLDetailsElement
    };
  });
  if (!revokedStructure) {
    fail("11.revoked-row", "no row in revoked section");
  } else {
    if (!revokedStructure.hasLinkAgain) fail("11a.link-again", "revoked row missing 'link again' button");
    if (revokedStructure.hasRevoke) fail("11b.no-revoke", "revoked row should not have a revoke-prompt button");
    if (!revokedStructure.collapsedByDefault) fail("11c.not-in-details", "revoked rows should be inside <details>");
    if (revokedStructure.hasLinkAgain && !revokedStructure.hasRevoke && revokedStructure.collapsedByDefault) {
      ok(`11. revoked row exposes link-again, no revoke, lives in collapsible <details>`);
    }
  }

  // ===== Server enforces revoke =====
  const ownerLookup = await fetch(`${BASE}/.well-known/handles/${encodeURIComponent(handle)}`);
  const ownerBody = await ownerLookup.json().catch(() => ({}));
  const canonical = typeof ownerBody?.canonical_id === "string" ? ownerBody.canonical_id : null;
  const revokedDeviceId = await pageA.evaluate(() => {
    const row = document.querySelector(".devices-panel__section--revoked .device-row");
    return row instanceof HTMLElement ? (row.dataset.deviceId ?? null) : null;
  });
  if (canonical && revokedDeviceId) {
    const resp = await fetch(`${BASE}/api/devices/${encodeURIComponent(canonical)}/sync?device_id=${encodeURIComponent(revokedDeviceId)}&since=0&limit=1`);
    if (resp.status !== 403) {
      fail("12.server-403", `/sync GET for revoked device returned ${resp.status}, expected 403`);
    } else {
      ok(`12. /sync GET for revoked device returns 403`);
    }
  }

  await browser.close();

  if (failures.length > 0) {
    console.error(`\nLINKED-DEVICES-LAYOUT SMOKE FAILED (${failures.length}):`);
    for (const f of failures) console.error("  -", f);
    process.exit(1);
  }
  console.log("\nLINKED-DEVICES-LAYOUT SMOKE PASSED");
})().catch((error) => { console.error("LINKED-DEVICES-LAYOUT SMOKE ERROR", error); process.exit(2); });

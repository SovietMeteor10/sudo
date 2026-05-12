#!/usr/bin/env node
// media-files smoke. Generic (non-image, non-video) attachment
// flow: A uploads a .txt file to B, B sees the file card with
// filename, extension chip, formatted size, and a working
// download button.

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const RECEIVE_BUDGET_MS = 15000;

let puppeteer;
try { puppeteer = require(PUPPETEER_CORE_PATH); }
catch (e) { console.error("install puppeteer-core first."); console.error(e.message); process.exit(2); }

const failures = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { console.log("ok:", label); };

async function waitFor(page, predicate, timeoutMs = 8000, intervalMs = 100, ...args) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, ...args)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function signUp(page, handle) {
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  return waitFor(page, () => document.body.dataset.authState === "signed-in", 15000);
}
async function lookupCanonical(handle) {
  const r = await fetch(`${BASE}/.well-known/handles/${encodeURIComponent(handle)}`);
  if (!r.ok) return null;
  const body = await r.json().catch(() => ({}));
  return typeof body?.canonical_id === "string" ? body.canonical_id : null;
}
async function openChat(page, target) {
  await page.evaluate((t) => {
    const list = document.getElementById("chat-list");
    if (list) {
      list.innerHTML = `<div class="chat-row" tabindex="0" role="button" data-chat-canonical="${t.canonical}" data-chat-handle="${t.handle}" data-chat-fingerprint=""></div>`;
    }
    document.querySelector(".chat-row")?.click();
  }, target);
  await waitFor(page, () => document.getElementById("chat-popup")?.hidden === false, 4000);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const ctxA = await browser.createBrowserContext();
    const pageA = await ctxA.newPage();
    pageA.on("pageerror", (err) => console.log("A-ERR>", err.message));
    await pageA.setViewport({ width: 980, height: 820 });
    await pageA.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleA = `mfa${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageA, handleA)) { fail("setup.A", "sign up A"); throw new Error(); }
    const canonicalA = await lookupCanonical(handleA);

    const ctxB = await browser.createBrowserContext();
    const pageB = await ctxB.newPage();
    pageB.on("pageerror", (err) => console.log("B-ERR>", err.message));
    await pageB.setViewport({ width: 980, height: 820 });
    await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });
    const handleB = `mfb${Date.now().toString().slice(-7)}`;
    if (!await signUp(pageB, handleB)) { fail("setup.B", "sign up B"); throw new Error(); }
    const canonicalB = await lookupCanonical(handleB);

    ok(`setup: A=@${handleA} B=@${handleB}`);

    await openChat(pageA, { canonical: canonicalB, handle: `@${handleB}` });
    await openChat(pageB, { canonical: canonicalA, handle: `@${handleA}` });

    // Inject a 12,345-byte plain text file with a non-standard ext.
    const fileBytes = Buffer.from("contents:".padEnd(12345, "x"), "utf-8");
    await pageA.evaluate((bytes) => {
      const input = document.getElementById("chat-popup-attachment-input");
      if (!(input instanceof HTMLInputElement)) throw new Error("no attachment input");
      const file = new File([new Uint8Array(bytes)], "smoke-report.weird-ext", { type: "application/octet-stream" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, Array.from(fileBytes));

    // 1. B renders a file CARD (not image / video).
    if (!await waitFor(pageB, () => {
      return document.querySelector(".chat-message__attachment-file") !== null;
    }, RECEIVE_BUDGET_MS)) {
      fail("1.render", "B did not render the file card");
      throw new Error();
    }
    ok(`1. B renders the file card (non-image)`);

    const cardState = await pageB.evaluate(() => {
      const card = document.querySelector(".chat-message__attachment-file");
      if (!(card instanceof HTMLElement)) return null;
      return {
        ext: card.querySelector(".chat-message__attachment-file__ext")?.textContent ?? null,
        name: card.querySelector(".chat-message__attachment-file__name")?.textContent ?? null,
        nameTitle: card.querySelector(".chat-message__attachment-file__name")?.getAttribute("title") ?? null,
        size: card.querySelector(".chat-message__attachment-file__size")?.textContent ?? null,
        hasDownload: card.querySelector(".chat-message__attachment-file__download") !== null
      };
    });
    if (cardState === null) {
      fail("2.shape", "file card has no expected children");
    } else {
      // ext slice(0,6) of "weird-ext" → "weird-"; verify it renders SOME ext.
      if (!cardState.ext || cardState.ext.length === 0) fail("2.ext", `missing extension chip: ${JSON.stringify(cardState)}`);
      else ok(`2. extension chip rendered ('${cardState.ext}')`);
      if (cardState.name !== "smoke-report.weird-ext") {
        fail("3.name", `filename wrong: ${cardState.name}`);
      } else if (cardState.nameTitle !== "smoke-report.weird-ext") {
        fail("3.title", `title attr wrong: ${cardState.nameTitle}`);
      } else {
        ok(`3. filename + title attribute round-trip`);
      }
      // 12,345 bytes → "12.1 KB"
      if (cardState.size !== "12.1 KB") {
        fail("4.size", `size formatting wrong: '${cardState.size}', expected '12.1 KB'`);
      } else {
        ok(`4. size formatted '${cardState.size}'`);
      }
      if (!cardState.hasDownload) fail("5.button", "no download button");
      else ok("5. download button present");
    }

    // 6. Click "open" — the download flow creates an object URL +
    //    triggers a download. We intercept the <a download> click
    //    to assert the URL is a blob: URL (decrypted client-side,
    //    not the raw /api/media URL).
    const openResult = await pageB.evaluate(async () => {
      let capturedHref = null;
      let capturedDownload = null;
      const origAppend = HTMLBodyElement.prototype.appendChild;
      // Monkey-patch <a>.click() so we intercept rather than
      // actually trigger a navigation.
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        capturedHref = this.href;
        capturedDownload = this.getAttribute("download");
      };
      try {
        const btn = document.querySelector(".chat-message__attachment-file__download");
        if (btn instanceof HTMLElement) btn.click();
        // Give the decrypt + URL creation a beat.
        await new Promise((r) => setTimeout(r, 1500));
        return { href: capturedHref, download: capturedDownload };
      } finally {
        HTMLAnchorElement.prototype.click = origClick;
      }
    });
    if (typeof openResult?.href !== "string" || !openResult.href.startsWith("blob:")) {
      fail("6.open", `expected blob: URL, got '${openResult?.href}'`);
    } else if (openResult.download !== "smoke-report.weird-ext") {
      fail("6.download-attr", `download attr wrong: '${openResult.download}'`);
    } else {
      ok(`6. open button creates blob: URL + download attribute carries the original filename`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`MEDIA-FILES SMOKE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("MEDIA-FILES SMOKE PASSED");
})().catch((err) => {
  console.error("MEDIA-FILES SMOKE ERRORED:", err);
  process.exit(1);
});

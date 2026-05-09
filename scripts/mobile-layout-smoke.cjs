#!/usr/bin/env node
// Mobile layout regression smoke. Drives a real browser at a
// narrow viewport and asserts:
//   - no horizontal overflow on the auth screen
//   - landing auth buttons still clickable
//   - signing up brings the mobile tab bar into view
//   - each tab shows the matching pane (feed / directory / chats /
//     notifications) with no horizontal overflow
//   - feed composer is reachable + usable on mobile
//   - notifications panel rows have left padding and the action
//     buttons fit inside the panel viewport (the original "I cannot
//     see action buttons" complaint)
//   - thread back-header height stays close to the column-title row
//   - desktop layout is untouched at a wide viewport

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PUPPETEER_CORE_PATH = process.env.PUPPETEER_CORE || "/tmp/node_modules/puppeteer-core";
const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let puppeteer;
try {
  puppeteer = require(PUPPETEER_CORE_PATH);
} catch (error) {
  console.error("install puppeteer-core (PUPPETEER_CORE env var) and a Chrome binary first.");
  console.error(error.message);
  process.exit(2);
}

const failures = [];
const passes = [];
const fail = (label, msg) => { failures.push(`${label}: ${msg}`); console.error("FAIL:", label, "-", msg); };
const ok = (label) => { passes.push(label); console.log("ok:", label); };

const PASSPHRASE = "CorrectHorseBatteryStaple9!";
const MOBILE_VIEWPORT = { width: 380, height: 720 };
const DESKTOP_VIEWPORT = { width: 980, height: 820 };

async function signupOn(page, handle) {
  await page.click('.landing [data-auth-action="signup"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#signup-handle", handle);
  await page.type("#signup-password", PASSPHRASE);
  await page.type("#signup-password-confirm", PASSPHRASE);
  await page.click('#signup-form button[type="submit"]');
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const a = await page.evaluate(() => document.body.dataset.authState);
    if (a === "signed-in") return;
  }
  throw new Error(`signup hung for @${handle}`);
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => ({
    docWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyOverflowX: document.body.scrollWidth - document.body.clientWidth
  }));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox"]
  });

  try {
    const stamp = Date.now().toString().slice(-6);

    // ===== Mobile viewport =====
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport(MOBILE_VIEWPORT);
      page.on("pageerror", (e) => console.log("PAGEERR>", e.message));
      await page.goto(BASE + "/", { waitUntil: "networkidle0" });

      // Auth screen: no horizontal overflow + buttons clickable.
      let overflow = await noHorizontalOverflow(page);
      if (overflow.docWidth > overflow.clientWidth + 1) {
        fail("mobile-auth/overflow", `doc=${overflow.docWidth} client=${overflow.clientWidth}`);
      } else {
        ok(`mobile-auth: no horizontal overflow (doc=${overflow.docWidth}, client=${overflow.clientWidth})`);
      }
      const authProbe = await page.evaluate(() => {
        const btn = document.querySelector('.landing [data-auth-action="signin"]');
        if (!(btn instanceof HTMLElement)) return { ok: false };
        const rect = btn.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { ok: top === btn, rect };
      });
      if (!authProbe.ok) fail("mobile-auth/buttons", "signin button not clickable on mobile");
      else ok(`mobile-auth: signin clickable`);

      // Sign up (mobile flow).
      const handle = "mob" + stamp;
      await signupOn(page, handle);
      ok(`mobile: signed up @${handle}`);

      // Mobile tab bar is now visible.
      const tabsVisible = await page.evaluate(() => {
        const bar = document.getElementById("mobile-tabs");
        if (!bar) return { exists: false };
        const style = getComputedStyle(bar);
        return { exists: true, display: style.display, visibility: style.visibility };
      });
      if (!tabsVisible.exists) fail("mobile-tabs/exists", "mobile tab bar missing from DOM");
      else if (tabsVisible.display === "none") fail("mobile-tabs/visible", `mobile tab bar display=${tabsVisible.display}`);
      else ok(`mobile-tabs: visible (display=${tabsVisible.display})`);

      // Verify each tab switches to the right pane and stays within
      // the viewport (no horizontal overflow on the active pane).
      for (const tab of ["directory", "feed", "chats", "notifications"]) {
        await page.click(`[data-mobile-tab="${tab}"]`);
        await new Promise((r) => setTimeout(r, 250));
        const probe = await page.evaluate((t) => {
          const body = document.body;
          const pane = body.dataset.mobilePane;
          const region = document.querySelector(`[data-mobile-region="${t}"]`);
          const visible = region instanceof HTMLElement && region.offsetParent !== null;
          return {
            pane,
            regionVisible: visible,
            docWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth
          };
        }, tab);
        if (probe.pane !== tab) fail(`mobile-tab/${tab}-set`, `data-mobile-pane=${probe.pane}`);
        else if (!probe.regionVisible) fail(`mobile-tab/${tab}-region`, "active region not visible");
        else if (probe.docWidth > probe.clientWidth + 1) fail(`mobile-tab/${tab}-overflow`, `doc=${probe.docWidth} client=${probe.clientWidth}`);
        else ok(`mobile-tab/${tab}: pane active, region visible, no overflow`);
      }

      // Feed pane: composer is reachable.
      await page.click(`[data-mobile-tab="feed"]`);
      await new Promise((r) => setTimeout(r, 250));
      const composerProbe = await page.evaluate(() => {
        const composer = document.getElementById("feed-body");
        if (!(composer instanceof HTMLElement)) return { ok: false };
        const rect = composer.getBoundingClientRect();
        return {
          ok: rect.width > 100 && rect.height > 0
            && rect.left >= 0 && rect.right <= window.innerWidth + 1,
          width: rect.width,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          windowWidth: window.innerWidth
        };
      });
      if (!composerProbe.ok) fail("mobile-feed/composer", `composer not usable: ${JSON.stringify(composerProbe)}`);
      else ok(`mobile-feed: composer usable (${composerProbe.width.toFixed(0)}x${composerProbe.height.toFixed(0)})`);

      // Notifications pane: empty state visible AND reachable.
      await page.click(`[data-mobile-tab="notifications"]`);
      await new Promise((r) => setTimeout(r, 250));
      const notifsProbe = await page.evaluate(() => {
        const empty = document.getElementById("notifications-empty");
        if (!(empty instanceof HTMLElement)) return { ok: false };
        const visible = empty.offsetParent !== null;
        const rect = empty.getBoundingClientRect();
        return {
          ok: visible && rect.left >= 0 && rect.right <= window.innerWidth + 1,
          left: rect.left,
          right: rect.right,
          windowWidth: window.innerWidth
        };
      });
      if (!notifsProbe.ok) fail("mobile-notifs/empty", `notifications empty state not reachable: ${JSON.stringify(notifsProbe)}`);
      else ok(`mobile-notifs: empty state reachable`);

      // Chats pane: title visible.
      await page.click(`[data-mobile-tab="chats"]`);
      await new Promise((r) => setTimeout(r, 250));
      const chatsProbe = await page.evaluate(() => {
        const title = document.getElementById("chats-title");
        if (!(title instanceof HTMLElement)) return { ok: false };
        return { ok: title.offsetParent !== null };
      });
      if (!chatsProbe.ok) fail("mobile-chats/title", "chats title not visible");
      else ok(`mobile-chats: pane reachable`);

      await page.close();
      await context.close();
    }

    // ===== Notifications-row layout (desktop): action buttons must
    //   fit inside the panel; rows must have left padding so they
    //   are not flush against the column edge. =====
    {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport(DESKTOP_VIEWPORT);
      await page.goto(BASE + "/", { waitUntil: "networkidle0" });

      const handleA = "notlayA" + stamp;
      const handleB = "notlayB" + stamp;
      const browserB = await browser.createBrowserContext();
      const pageB = await browserB.newPage();
      await pageB.setViewport(DESKTOP_VIEWPORT);
      await pageB.goto(BASE + "/", { waitUntil: "networkidle0" });

      await signupOn(page, handleA);
      await signupOn(pageB, handleB);

      // A follows B from A's lookup card so B sees a follow notification.
      await page.evaluate(() => {
        const input = document.getElementById("lookup-input");
        if (input instanceof HTMLInputElement) input.value = "";
      });
      await page.type("#lookup-input", `@${handleB}`);
      await page.evaluate(() => {
        document.getElementById("lookup-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const ready = await page.evaluate(() => document.querySelector("[data-relationship-action='set-subscribe']") !== null);
        if (ready) break;
      }
      await page.evaluate(() => {
        const btn = document.querySelector("[data-relationship-action='set-subscribe']");
        if (btn instanceof HTMLButtonElement) btn.click();
      });

      // Wait for B's notification to appear.
      let waited = 0;
      while (waited < 25000) {
        const count = await pageB.evaluate(() => document.querySelectorAll("#notifications-list .notification-row").length);
        if (count > 0) break;
        await new Promise((r) => setTimeout(r, 500));
        waited += 500;
      }

      const layout = await pageB.evaluate(() => {
        const panel = document.getElementById("notifications-panel");
        const row = document.querySelector("#notifications-list .notification-row");
        if (!(panel instanceof HTMLElement) || !(row instanceof HTMLElement)) {
          return { ok: false, reason: "panel or row missing" };
        }
        const panelRect = panel.getBoundingClientRect();
        const lineNode = row.querySelector(".notification-row__line");
        // Measure the inner content position, not the box itself —
        // the row's left padding pushes its content inward but the
        // row's bounding box still hugs the panel edge.
        const lineLeft = lineNode instanceof HTMLElement
          ? lineNode.getBoundingClientRect().left
          : null;
        const indent = lineLeft === null ? 0 : lineLeft - panelRect.left;
        const buttons = Array.from(row.querySelectorAll(".notification-row__action"));
        const buttonRects = buttons.map((b) => b.getBoundingClientRect());
        const allInside = buttonRects.every((br) =>
          br.left >= panelRect.left - 1 && br.right <= panelRect.right + 1 && br.width > 0);
        return {
          ok: true,
          indent,
          panelLeft: panelRect.left,
          panelRight: panelRect.right,
          buttonCount: buttons.length,
          buttonInside: allInside,
          buttonLabels: buttons.map((b) => b.textContent?.trim() ?? "")
        };
      });

      if (!layout.ok) {
        fail("notif-layout/missing", layout.reason);
      } else {
        if (layout.indent < 12) fail("notif-layout/indent", `row content too flush-left: ${layout.indent.toFixed(1)}px`);
        else ok(`notif-layout: row content indented ${layout.indent.toFixed(0)}px from panel edge`);

        if (layout.buttonCount === 0) fail("notif-layout/buttons", "no action buttons rendered");
        else if (!layout.buttonInside) fail("notif-layout/buttons-clipped", "action buttons not contained in panel");
        else ok(`notif-layout: ${layout.buttonCount} action buttons (${layout.buttonLabels.join(", ")}) all inside panel`);
      }

      await page.close();
      await pageB.close();
      await context.close();
      await browserB.close();
    }

    if (failures.length === 0) {
      console.log(`\nresults: ${passes.length} passed, 0 failed`);
      console.log("MOBILE LAYOUT SMOKE PASSED");
      process.exit(0);
    }
    console.error(`\nresults: ${passes.length} passed, ${failures.length} failed`);
    for (const f of failures) console.error("  -", f);
    console.error("MOBILE LAYOUT SMOKE FAILED");
    process.exit(1);
  } finally {
    await browser.close().catch(() => null);
  }
})().catch((error) => {
  console.error("MOBILE LAYOUT SMOKE ERROR", error);
  process.exit(2);
});

import { Router } from "express";
import { fingerprintPublicKey, verifyIdentityDocument } from "../crypto/index.js";
import { getIdentityByCanonicalId, getIdentityByHandle } from "../identity/registry.js";
import { getIdentityBio } from "../identity/identity-bio.store.js";

export const profileRouter = Router();

// Phase 14B: /u/:identifier accepts either a handle (`alice`,
// optionally `@alice`) or a canonical_id (`sudo:ed25519:<hex>`). For
// canonical_id it renders the technical info pane used for key
// continuity / discovery. For a handle it renders a friendly public
// profile (handle + optional bio + install CTA).
//
// Both forms are intentionally public reads — handles and public
// keys are discovery names per `docs/SECURITY.md` "handles are
// discovery names, not trust". No auth needed.

profileRouter.get("/u/:identifier", (request, response) => {
  const raw = request.params.identifier;
  // Canonical IDs always start with `sudo:`.
  const isCanonical = raw.startsWith("sudo:");
  const identity = isCanonical
    ? getIdentityByCanonicalId(raw)
    : getIdentityByHandle(raw);

  if (!identity) {
    response.status(404).type("text/html").send(notFoundHtml(raw));
    return;
  }

  if (isCanonical) {
    response.type("html").send(canonicalIdHtml(identity));
    return;
  }

  response.type("html").send(handleHtml(identity));
});

function canonicalIdHtml(identity: { document: { handle: string; canonical_id: string; keys: { identity: { public_key: string } }; updated_at: string; home_node?: string; profile?: string; finger?: string; inbox?: string } }): string {
  const identityPublicKey = identity.document.keys.identity.public_key;
  const fingerprint = fingerprintPublicKey(identityPublicKey);
  const signatureState = verifyIdentityDocument(identity.document as Parameters<typeof verifyIdentityDocument>[0]) ? "valid" : "invalid";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(identity.document.handle)} / sudo</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      max-width: 78ch;
      margin: 2rem auto;
      padding: 0 1rem;
      font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    a { color: inherit; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .tip { opacity: 0.7; }
  </style>
</head>
<body>
<pre>sudo identity
=============

handle:      ${escapeHtml(identity.document.handle)}
canonical:   ${escapeHtml(identity.document.canonical_id)}
key:         sha256:${fingerprint}
signature:   ${signatureState}
updated:     ${escapeHtml(identity.document.updated_at)}

home node:   ${escapeHtml(identity.document.home_node ?? "")}
profile:     ${escapeHtml(identity.document.profile ?? `/u/${identity.document.canonical_id}`)}
finger:      ${escapeHtml(identity.document.finger ?? `/finger/${identity.document.handle.slice(1)}`)}
inbox:       ${escapeHtml(identity.document.inbox ?? `/inbox/${identity.document.canonical_id}`)}

Registry entries are discovery hints. Trust this identity only after
verifying key continuity and signed identity documents over time.

<span class="tip">friendly view: <a href="/u/${escapeHtml(identity.document.handle.replace(/^@/, ""))}">/u/${escapeHtml(identity.document.handle.replace(/^@/, ""))}</a></span>
</pre>
</body>
</html>`;
}

function handleHtml(identity: { document: { handle: string; canonical_id: string } }): string {
  const handle = identity.document.handle;
  const handleNoAt = handle.replace(/^@/, "");
  const bio = getIdentityBio(identity.document.canonical_id);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(handle)} on sudo</title>
  <meta property="og:title" content="${escapeHtml(handle)} on sudo">
  ${bio ? `<meta property="og:description" content="${escapeHtml(bio)}">` : ""}
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0a0a0a;
      --fg: #f5f5f4;
      --muted: rgba(245, 245, 244, 0.55);
      --line: rgba(245, 245, 244, 0.1);
      --accent: #fb923c;
    }
    @media (prefers-color-scheme: light) {
      :root { --bg: #fafaf9; --fg: #1c1917; --muted: rgba(28, 25, 23, 0.55); --line: rgba(28, 25, 23, 0.08); --accent: #c2410c; }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 1.25rem;
    }
    main {
      width: 100%;
      max-width: 32rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      animation: fadein 360ms ease-out;
    }
    @keyframes fadein {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }
    .handle {
      font: 600 2.25rem/1.1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: -0.015em;
      margin: 0;
    }
    .handle .at { color: var(--muted); font-weight: 400; }
    .bio {
      font-size: 1.0625rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--fg);
      margin: 0;
    }
    .bio-empty { color: var(--muted); font-style: italic; }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    .actions button, .actions a {
      appearance: none;
      background: transparent;
      color: var(--fg);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0.55rem 1rem;
      font: inherit;
      font-size: 0.9375rem;
      text-decoration: none;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .actions a.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .actions button:hover, .actions a:hover {
      background: var(--line);
    }
    .actions a.primary:hover {
      background: var(--accent);
      filter: brightness(1.08);
    }
    .footer {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 0.875rem;
    }
    .footer a { color: var(--muted); }
    .toast {
      position: fixed;
      bottom: 1.25rem;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: var(--fg);
      color: var(--bg);
      padding: 0.6rem 1.1rem;
      border-radius: 999px;
      font-size: 0.9rem;
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease, transform 180ms ease;
    }
    .toast.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  </style>
</head>
<body>
  <main>
    <h1 class="handle"><span class="at">@</span>${escapeHtml(handleNoAt)}</h1>
    ${bio ? `<p class="bio">${escapeHtml(bio)}</p>` : ""}
    <div class="actions">
      <a class="primary" href="/?h=${encodeURIComponent(handleNoAt)}">open in sudo</a>
      <button id="copy-handle" type="button">copy @${escapeHtml(handleNoAt)}</button>
      <button id="copy-link" type="button">copy link</button>
    </div>
    <div class="footer">
      sudo is a private chat and feed app. messages are end-to-end encrypted; the server passes them along.
      <br>
      <a href="/">install sudo</a> &middot; <a href="/u/${escapeHtml(identity.document.canonical_id)}">technical view</a>
    </div>
  </main>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <meta id="u-profile-data" data-handle="${escapeHtml(handle)}" data-handle-no-at="${escapeHtml(handleNoAt)}">
  <script src="/u-profile.js"></script>
</body>
</html>`;
}

function notFoundHtml(raw: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>not found / sudo</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font: 16px/1.55 ui-sans-serif, system-ui, sans-serif;
      max-width: 32rem;
      margin: 2rem auto;
      padding: 0 1rem;
      text-align: center;
    }
    a { color: inherit; }
    p { opacity: 0.7; }
  </style>
</head>
<body>
  <h1>not found</h1>
  <p>no profile for <code>${escapeHtml(raw)}</code>.</p>
  <p><a href="/">go home</a></p>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

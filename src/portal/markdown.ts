// Tiny markdown -> HTML renderer for the user-facing docs served at
// /docs/<file>. The doc source is owned by us (committed in this
// repo), so the threat model here is defense-in-depth, not adversarial
// content. Even so, the renderer:
//
//   - escapes every character of source HTML before any transform
//   - rejects URLs that aren't http(s), absolute-path, anchor, or
//     a relative `.md` doc
//   - emits zero inline scripts, zero event handlers, zero raw HTML
//
// Supported features (deliberately small): headings (# .. ######),
// horizontal rules (---), bullet lists (- or *), paragraphs,
// fenced code blocks (```), inline code (`code`), bold (**bold**),
// italic (*italic*), and links ([label](url)). No tables, no
// blockquotes, no images, no inline HTML.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  // The href is going inside double quotes. Encode the dangerous
  // characters so they cannot escape the attribute or smuggle a
  // protocol switch.
  return s
    .replace(/"/g, "%22")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")
    .replace(/'/g, "%27");
}

function sanitizeUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0 || url.length > 2048) return null;
  // http(s)://
  if (/^https?:\/\/[^\s]+$/i.test(url)) return url;
  // absolute path
  if (/^\/[\w\-./?#=&%~]*$/.test(url)) return url;
  // in-document anchor
  if (/^#[\w\-]+$/.test(url)) return url;
  // sibling doc reference (e.g. "TRUST_MODEL.md")
  if (/^[A-Za-z0-9_-]+\.md$/.test(url)) return url;
  return null;
}

function renderInline(text: string): string {
  // Escape HTML first — every transform below operates on the safe
  // form and emits new safe tags.
  let out = escapeHtml(text);

  // Inline code (`...`). Done before bold/italic so * inside code
  // doesn't get re-interpreted. The `[^`]+` non-greedy capture
  // handles non-nested cases.
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`);

  // Links [label](url). After escapeHtml, `[`, `]`, `(`, `)` are
  // literal; the regex uses balanced single-pair brackets. URL is
  // sanitized; a rejected URL falls back to plaintext label.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const safe = sanitizeUrl(url);
    if (safe === null) return label;
    return `<a href="${escapeAttr(safe)}">${label}</a>`;
  });

  // Bold (**text**). After bold so italic doesn't eat one of the asterisks.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

  // Italic (*text*). The leading/trailing lookbehind/ahead prevents
  // gluing onto a remaining * from a bold pair (none should remain
  // after the bold pass, but defensive).
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

  return out;
}

export function renderMarkdownToHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block.
    if (/^```/.test(line)) {
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      i++; // consume closing fence
      blocks.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    // Horizontal rule.
    if (/^---+\s*$/.test(line)) {
      blocks.push("<hr>");
      i++;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }

    // Bullet list (one level, no nesting).
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Blank line — paragraph separator.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: consume consecutive non-special lines.
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length
      && lines[i]!.trim() !== ""
      && !/^#{1,6}\s/.test(lines[i]!)
      && !/^```/.test(lines[i]!)
      && !/^[-*]\s+/.test(lines[i]!)
      && !/^---+\s*$/.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i++;
    }
    blocks.push(`<p>${renderInline(paraLines.join(" "))}</p>`);
  }

  return blocks.join("\n");
}

// Wrap the rendered HTML in a sudo-styled shell. CSS is inline so
// docs survive without the app's main stylesheet and stay under the
// hash-pinned CSP (no external script, no inline JS).
export function wrapDocHtml(options: { title: string; bodyHtml: string }): string {
  const safeTitle = escapeHtml(options.title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${safeTitle} — sudo</title>
  <meta property="og:title" content="${safeTitle} — sudo">
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0a0a0a;
      --fg: #f5f5f4;
      --muted: rgba(245, 245, 244, 0.62);
      --line: rgba(245, 245, 244, 0.12);
      --code-bg: rgba(245, 245, 244, 0.06);
      --accent: #fb923c;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #fafaf9;
        --fg: #1c1917;
        --muted: rgba(28, 25, 23, 0.58);
        --line: rgba(28, 25, 23, 0.10);
        --code-bg: rgba(28, 25, 23, 0.05);
        --accent: #c2410c;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--fg);
      font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: env(safe-area-inset-top) 1rem env(safe-area-inset-bottom);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .doc-shell {
      width: 100%;
      max-width: 38rem;
      padding: 2rem 0 3rem;
    }
    .doc-shell__nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      padding-bottom: 1.25rem;
      border-bottom: 1px solid var(--line);
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
      color: var(--muted);
    }
    .doc-shell__nav a {
      color: var(--muted);
      text-decoration: none;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0.35rem 0.75rem;
      transition: color 140ms ease, border-color 140ms ease;
    }
    .doc-shell__nav a:hover,
    .doc-shell__nav a:focus-visible {
      color: var(--fg);
      border-color: var(--fg);
      outline: none;
    }
    .doc-shell__brand {
      font-weight: 500;
      letter-spacing: 0.02em;
    }
    .doc-shell__body h1 {
      font: 600 1.875rem/1.2 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: -0.015em;
      margin: 0 0 1rem;
    }
    .doc-shell__body h2 {
      font: 500 1.375rem/1.25 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: -0.01em;
      margin: 2rem 0 0.75rem;
    }
    .doc-shell__body h3 {
      font: 500 1.125rem/1.3 ui-sans-serif, system-ui, sans-serif;
      margin: 1.5rem 0 0.5rem;
      color: var(--fg);
    }
    .doc-shell__body p {
      margin: 0 0 1rem;
    }
    .doc-shell__body ul {
      padding-left: 1.25rem;
      margin: 0 0 1rem;
    }
    .doc-shell__body li { margin-bottom: 0.35rem; }
    .doc-shell__body li::marker { color: var(--muted); }
    .doc-shell__body hr {
      border: 0;
      border-top: 1px solid var(--line);
      margin: 2rem 0;
    }
    .doc-shell__body a {
      color: var(--fg);
      text-decoration: underline;
      text-decoration-color: var(--line);
      text-underline-offset: 0.18em;
      transition: text-decoration-color 140ms ease;
    }
    .doc-shell__body a:hover,
    .doc-shell__body a:focus-visible {
      text-decoration-color: var(--fg);
      outline: none;
    }
    .doc-shell__body code {
      background: var(--code-bg);
      padding: 0.1em 0.35em;
      border-radius: 3px;
      font: 0.875em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
    }
    .doc-shell__body pre {
      background: var(--code-bg);
      padding: 0.85rem 1rem;
      border-radius: 6px;
      overflow-x: auto;
      margin: 0 0 1.25rem;
      font-size: 0.85rem;
      line-height: 1.55;
    }
    .doc-shell__body pre code {
      background: transparent;
      padding: 0;
      font-size: inherit;
    }
    .doc-shell__body strong { font-weight: 600; }
    .doc-shell__body em { font-style: italic; }
    .doc-shell__footer {
      margin-top: 2.5rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--line);
      font-size: 0.8125rem;
      color: var(--muted);
    }
    @media (max-width: 480px) {
      body { padding-left: 1rem; padding-right: 1rem; }
      .doc-shell { padding: 1.25rem 0 2rem; }
      .doc-shell__body h1 { font-size: 1.5rem; }
      .doc-shell__body h2 { font-size: 1.1875rem; margin-top: 1.5rem; }
      .doc-shell__body h3 { font-size: 1.0625rem; }
      body { font-size: 15px; line-height: 1.55; }
    }
  </style>
</head>
<body>
  <article class="doc-shell">
    <nav class="doc-shell__nav" aria-label="document navigation">
      <span class="doc-shell__brand">sudo · docs</span>
      <a href="/">back to sudo</a>
    </nav>
    <div class="doc-shell__body">
      ${options.bodyHtml}
    </div>
    <footer class="doc-shell__footer">
      this document is part of the sudo project source. read more at <a href="/">sudo</a>.
    </footer>
  </article>
</body>
</html>`;
}

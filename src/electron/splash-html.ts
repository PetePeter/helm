import { escapeHtmlAttribute } from '../utils/html.js';

export function buildSplashHtml(version: string, logoUrl?: string): string {
  const safeVersion = escapeHtmlAttribute(version);
  const safeLogoUrl = logoUrl ? escapeHtmlAttribute(logoUrl) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Helm Launching</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0a0a;
      --panel: rgba(17, 17, 17, 0.94);
      --accent: #4fd08b;
      --accent-soft: rgba(79, 208, 139, 0.24);
      --text: #eeeeee;
      --muted: #9a9a9a;
      --border: rgba(79, 208, 139, 0.24);
      font-family: "Segoe UI", Arial, sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      /* Fixed 460x320 frameless window: the card is only just shorter than the
         viewport, so DPI rounding would otherwise produce a scrollbar on a
         window the user cannot scroll or resize anyway. */
      height: 100vh;
      overflow: hidden;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(79, 208, 139, 0.18), transparent 42%),
        linear-gradient(180deg, rgba(17, 17, 17, 0.98), rgba(10, 10, 10, 1));
      color: var(--text);
    }

    .card {
      width: min(420px, calc(100vw - 40px));
      padding: 32px 28px;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
      text-align: center;
    }

    .mark {
      width: 88px;
      height: 88px;
      margin: 0 auto 16px;
      border-radius: 22px;
      display: grid;
      place-items: center;
      color: var(--accent);
      background: linear-gradient(180deg, rgba(79, 208, 139, 0.12), rgba(79, 208, 139, 0.04));
      box-shadow: inset 0 0 0 1px var(--accent-soft);
      font-size: 34px;
      font-weight: 700;
      letter-spacing: -0.08em;
    }

    .mark img {
      width: 64px;
      height: 64px;
      object-fit: contain;
    }

    .eyebrow {
      margin: 0 0 8px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      font-size: 40px;
      line-height: 1.08;
    }

    .tagline {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 16px;
    }

    .version {
      margin: 18px 0 0;
      color: var(--muted);
      font-size: 12px;
      opacity: 0.75;
    }
  </style>
</head>
<body>
  <main class="card" role="status" aria-live="polite" aria-label="Launching Helm">
    <div class="mark" aria-hidden="true">${safeLogoUrl ? `<img src="${safeLogoUrl}" alt="">` : '|&gt;'}</div>
    <p class="eyebrow">Launching Helm</p>
    <h1>Helm</h1>
    <p class="tagline">steer your fleet of agents</p>
    <p class="version">v${safeVersion}</p>
  </main>
</body>
</html>`;
}

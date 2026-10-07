/**
 * artifact-base-css — the stylesheet for markdown artifacts, and the fallback
 * for HTML artifacts that ship no styling of their own.
 *
 * Markdown always gets it. For HTML the policy is "artifact decides, app
 * provides fallback": it is injected ONLY when the document contains no
 * <style>, no stylesheet <link> and no inline style attribute (see
 * build-artifact-document.ts). An author who styled anything gets a bare
 * document and full control.
 *
 * Token values are inlined as literals rather than var(--…) because CSS custom
 * properties do not cross the document boundary — the artifact is served as its
 * own document over helm-artifact://, so it inherits nothing from the app.
 * Values mirror renderer/styles/main.css :root.
 */
export const ARTIFACT_BASE_CSS = `
:root { color-scheme: dark; }
body {
  margin: 16px;
  background: #0a0a0a;
  color: #eee;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 12px;
  line-height: 1.6;
}
h1, h2 { font-size: 20px; margin: 0 0 8px; border-bottom: 1px solid #222222; padding-bottom: 4px; }
h3 { font-size: 14px; margin: 16px 0 4px; color: #4fd08b; }
p { margin: 4px 0; }
ul, ol { margin: 4px 0; padding-left: 16px; }
li { line-height: 1.55; margin: 4px 0; }
code { background: #1a1a1a; padding: 4px 8px; border-radius: 4px; font-family: Consolas, monospace; font-size: 12px; color: #4fd08b; }
pre { background: #1a1a1a; padding: 8px 16px; border-radius: 8px; overflow: auto; }
pre code { background: none; padding: 0; }
pre.mermaid { background: transparent; padding: 8px 0; text-align: center; }
pre.mermaid-failed { border: 1px dashed #663333; border-radius: 4px; padding: 8px; text-align: left; }
.mermaid-fail-note { font-size: 10px; color: #ff5f5f; margin-top: 4px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
th, td { border: 1px solid #222222; padding: 4px 8px; text-align: left; }
th { background: #1a1a1a; color: #999; }
a { color: #6c8cff; }
a:focus-visible { outline: 2px solid #4fd08b; outline-offset: 2px; }
img { max-width: 100%; border-radius: 8px; border: 1px solid #222222; }
svg { max-width: 100%; height: auto; }
`.trim();

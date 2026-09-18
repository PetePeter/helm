package com.potatomotato.helm.ui.artifacts

/**
 * The containment an artifact HTML body gets before a WebView ever sees it.
 *
 * Artifact content is AI-authored, which invariant 9 makes untrusted, so it is
 * never rendered as it arrived. The desktop contains it in an opaque-origin
 * iframe behind a response-header CSP (docs/artifact-viewer's
 * `ARTIFACT_CSP`); a WebView has no response header to speak of, so the SAME
 * policy arrives as a meta tag injected INTO the document, and the document is
 * loaded with a null base URL — an opaque origin, the mobile half of the same
 * answer.
 *
 * Pure Kotlin and Android-free, like every other `*Rules` module: the injection
 * and escaping decisions are the parts worth testing, and they test on the JVM.
 */
object HtmlContainment {

    /**
     * The desktop's artifact policy, minus the two directives a meta tag cannot
     * carry (frame-ancestors is response-only) and the one scheme the phone does
     * not have (helm-img:). `script-src 'unsafe-inline'` stays: an artifact may
     * run its own script — that is what "rendered page" means — contained by the
     * default-src 'none' that leaves it nothing to reach.
     */
    const val CSP_META: String =
        "<meta http-equiv=\"Content-Security-Policy\" " +
            "content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; " +
            "font-src data:; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'\">"

    /**
     * Put the CSP into [html]: into its `<head>` when there is one, otherwise
     * inside a head built for it. ALWAYS injected, never skipped for a document
     * that already carries a policy: multiple CSPs intersect (the most
     * restrictive directive wins), so ours only ever TIGHTENS what the artifact
     * wrote — and skipping ours because the body mentions a CSP (its own, or one
     * merely quoted in prose) would strip the connect-src and frame layers the
     * artifact never had.
     */
    fun injectCsp(html: String): String {
        val head = HEAD_OPEN.find(html)?.range
            ?: HTML_OPEN.find(html)?.range
            ?: return "$HEAD_OPEN_NONE$CSP_META$HEAD_CLOSE_NONE$html"
        return StringBuilder(html).insert(head.last + 1, CSP_META).toString()
    }

    /**
     * The whole document one mermaid diagram renders inside: the CSP, a bare
     * style, the diagram source as ESCAPED text in a `pre.mermaid`, the mermaid
     * bundle inlined — never fetched, there is no network to fetch from — and
     * the strict/dark initialise the desktop uses.
     *
     * After the render settles the page reports its own height back by
     * navigating to `helm-diagram://height/<px>`; the WebView intercepts the
     * navigation (see [com.potatomotato.helm.ui.artifacts.ContainedWebView] —
     * the composable, not this object) and sizes the view. A channel with no JS
     * bridge in either direction.
     */
    fun diagramDocument(source: String, mermaidBundle: String): String = buildString {
        append(DOCTYPE)
        append("<head>")
        append(CSP_META)
        append(STYLE)
        append("</head><body><pre class=\"mermaid\">")
        append(escape(source))
        append("</pre><script>")
        append(inlineScript(mermaidBundle))
        append("</script><script>")
        append(INITIALISE)
        append("</script></body></html>")
    }

    /**
     * Inline a script bundle into a `<script>` element. A literal `</script>`
     * anywhere in the bundle — a string literal in the minified code, say —
     * would close the element early and turn the rest of the bundle into page
     * markup. `<\/script` inside a JavaScript string is the same characters back
     * again, so the bundle is only ever made safe, never changed in meaning.
     */
    fun inlineScript(bundle: String): String =
        bundle.replace("</script", "<\\/script", ignoreCase = true)

    /**
     * Text that may be markup becomes entities. Mermaid reads the `<pre>`'s text
     * content, so the author's characters come back out unchanged; what cannot
     * happen is the browser parsing them as elements first.
     */
    private fun escape(text: String): String = buildString(text.length) {
        for (ch in text) {
            when (ch) {
                '&' -> append("&amp;")
                '<' -> append("&lt;")
                '>' -> append("&gt;")
                '"' -> append("&#34;")
                '\'' -> append("&#39;")
                else -> append(ch)
            }
        }
    }

    private val HEAD_OPEN = Regex("""<head[^>]*>""", RegexOption.IGNORE_CASE)
    private val HTML_OPEN = Regex("""<html[^>]*>""", RegexOption.IGNORE_CASE)

    private const val DOCTYPE = "<!DOCTYPE html><html>"
    private const val HEAD_OPEN_NONE = "<head>"
    private const val HEAD_CLOSE_NONE = "</head>"
    private const val STYLE = "<style>html,body{margin:0;padding:0;background:transparent}</style>"
    private const val INITIALISE =
        "mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'dark'});" +
            "mermaid.run({querySelector:\".mermaid\"}).then(function(){" +
            "requestAnimationFrame(function(){var b=document.body;" +
            "location.href=\"helm-diagram://height/\"+Math.ceil(Math.max(" +
            "b.scrollWidth,b.scrollHeight));});" +
            "},function(){location.href=\"helm-diagram://height/0\";});"
}

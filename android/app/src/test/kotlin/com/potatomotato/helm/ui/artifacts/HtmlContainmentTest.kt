package com.potatomotato.helm.ui.artifacts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The containment an artifact HTML body gets before a WebView ever sees it.
 *
 * Artifact content is AI-authored — untrusted by invariant 9 — so the CSP that
 * the desktop ships as a response header (see docs/artifact-viewer.md) has to
 * arrive here as a meta tag injected INTO the document, and the mermaid shell
 * that renders diagrams has to inline its bundle rather than fetch it. These
 * tests pin the two properties that matter: a document leaves this object
 * carrying our CSP alongside whatever it already had (policies intersect, so
 * ours only tightens), and nothing authored can break out of a script tag.
 */
class HtmlContainmentTest {

    @Test
    fun `the csp meta lands right after an existing head`() {
        val html = "<!DOCTYPE html><html><head><title>x</title></head><body>hi</body></html>"

        val contained = HtmlContainment.injectCsp(html)

        assertTrue(contained.startsWith("<!DOCTYPE html><html><head>" + HtmlContainment.CSP_META))
        assertTrue(contained.endsWith("<title>x</title></head><body>hi</body></html>"))
    }

    @Test
    fun `a document with no head gets one built for it`() {
        val html = "<p>just a fragment</p>"

        val contained = HtmlContainment.injectCsp(html)

        assertEquals(
            "<head>" + HtmlContainment.CSP_META + "</head><p>just a fragment</p>",
            contained,
        )
    }

    @Test
    fun `a document already carrying a csp gets ours anyway`() {
        val html = """<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head>""" +
            "<body>hi</body></html>"

        val contained = HtmlContainment.injectCsp(html)

        // Multiple policies INTERSECT — the most restrictive directive wins — so
        // ours only ever tightens what the artifact wrote. Skipping ours whenever
        // the body mentions a CSP would strip the layers the artifact never had.
        assertEquals(2, Regex("Content-Security-Policy", RegexOption.IGNORE_CASE).findAll(contained).count())
        assertTrue(contained.contains(HtmlContainment.CSP_META))
    }

    @Test
    fun `the diagram shell carries the csp and the strict dark init`() {
        val doc = HtmlContainment.diagramDocument("flowchart TD\n  A --> B", "bundle;")

        assertTrue(doc.contains(HtmlContainment.CSP_META))
        assertTrue(doc.contains("securityLevel:'strict'"))
        assertTrue(doc.contains("theme:'dark'"))
    }

    @Test
    fun `the diagram source rides as escaped text, never as markup`() {
        val doc = HtmlContainment.diagramDocument("A --> \"B\" <script>alert(1)</script>", "bundle;")

        // Mermaid reads the <pre>'s TEXT content, so escaped entities decode back
        // to the author's characters — but they cannot be markup in the meantime.
        assertTrue(doc.contains("A --&gt; &#34;B&#34; &lt;script&gt;alert(1)&lt;/script&gt;"))
        assertFalse(doc.contains("<script>alert(1)"))
    }

    @Test
    fun `the mermaid bundle is inlined and cannot close the script tag early`() {
        val doc = HtmlContainment.diagramDocument("graph LR", "var x = \"</script>\";")

        // Exactly two script blocks close — the bundle's and the init's. A `</script>`
        // inside the bundle's own string literals became `<\/script`, which JavaScript
        // reads back as the same characters.
        assertEquals(2, Regex("</script>").findAll(doc).count())
        assertTrue(doc.contains("var x = \"<\\/script>\";"))
    }
}

package com.potatomotato.helm.ui.artifacts

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.potatomotato.helm.R
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius

/**
 * The one WebView this app allows, and the shape every untrusted document takes
 * in it — invariant 9's answer for content that needs a browser to render.
 *
 * The document arrives ALREADY CONTAINED ([HtmlContainment.injectCsp] or
 * [HtmlContainment.diagramDocument] built it) and is loaded against a null base
 * URL, so it runs on an opaque origin with nothing of the app's to reach. The
 * settings switch off everything the CSP cannot say: no file or content access,
 * no network loads at all. There is deliberately NO `addJavascriptInterface` —
 * the page's only way out is a navigation this client intercepts and swallows,
 * which is also the channel a diagram reports its rendered height through.
 *
 * One instance per document, disposed with it (`onRelease` destroys the view,
 * which is what frees the render thread and the context) — a mermaid fence in a
 * LazyColumn is a view per fence. The deliberate COST of keeping it this
 * simple: each diagram shell embeds its own COPY of the ~3.5MB mermaid bundle
 * (`diagramDocument` builds the document string per fence), so a document with
 * many fences holds many copies in memory. Accepted because the common
 * artifact carries one or two diagrams; if that stops being true, pooling is
 * the fix, not a second renderer.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ContainedWebView(
    html: String,
    modifier: Modifier = Modifier,
    onDiagramHeight: ((cssPixels: Int) -> Unit)? = null,
) {
    var loaded: String? by remember { mutableStateOf(null) }
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.blockNetworkLoads = true
                settings.cacheMode = WebSettings.LOAD_NO_CACHE
                settings.mediaPlaybackRequiresUserGesture = true
                // The document's own CSS paints nothing behind it, so the view
                // reads as the app's canvas rather than a browser sheet.
                setBackgroundColor(HelmColors.Bg.toArgb())
                webViewClient = ContainedClient(onDiagramHeight)
            }
        },
        update = { view ->
            // Only a NEW document reloads: an update pass is recomposition, not
            // a reason to restart a page the user is reading.
            if (loaded != html) {
                loaded = html
                view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            }
        },
        onRelease = { view ->
            // A disposed WebView holds its render thread and its context until
            // destroy() is called; AndroidView will not call it for us.
            view.destroy()
        },
    )
}

private class ContainedClient(private val onDiagramHeight: ((Int) -> Unit)?) : WebViewClient() {
    /**
     * Every navigation is refused. The one legal use is the diagram shell's
     * `helm-diagram://height/<px>` report, which is not a navigation at all —
     * it is the page handing a measurement to this callback before the jump is
     * swallowed with the rest.
     */
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (onDiagramHeight != null && url.scheme == DIAGRAM_SCHEME && url.host == DIAGRAM_HEIGHT_HOST) {
            onDiagramHeight(url.lastPathSegment?.toIntOrNull() ?: 0)
        }
        return true
    }
}

/**
 * One mermaid diagram, rendered by the same contained shell the desktop uses.
 *
 * The diagram draws at its own height, which only the page knows once mermaid
 * has laid it out; it reports through the shell's channel and the composable
 * sizes itself to match, clamped so one huge diagram cannot become an endless
 * column. Until the first report arrives the view holds at the minimum, which
 * is one line of "rendering" rather than a lie about the size.
 */
@Composable
fun MermaidDiagram(source: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val bundle = remember { mermaidBundle(context) }

    if (bundle == null) {
        // The bundle ships in the APK; failing to read it is a build mistake,
        // not a network problem, and the source stays readable as text.
        HelmLog.w(HelmLog.CLIENT, "the mermaid bundle is missing from assets")
        Text(
            text = source,
            color = HelmColors.Terminal,
            style = MaterialTheme.typography.bodySmall,
            modifier = modifier,
        )
        return
    }

    var heightDp by remember { mutableIntStateOf(MIN_HEIGHT_DP) }
    val html = remember(source, bundle) { HtmlContainment.diagramDocument(source, bundle) }
    ContainedWebView(
        html = html,
        modifier = modifier
            .fillMaxWidth()
            .height(heightDp.dp)
            .clip(RoundedCornerShape(HelmRadius.Sm)),
        onDiagramHeight = { cssPixels ->
            heightDp = (cssPixels / density.density).toInt().coerceIn(MIN_HEIGHT_DP, MAX_HEIGHT_DP)
        },
    )
}

/** Read the mermaid bundle the APK ships, once per process; null if it is gone. */
private fun mermaidBundle(context: Context): String? {
    cachedBundle?.let { return it }
    return try {
        context.assets.open(MERMAID_ASSET).bufferedReader().use { reader -> reader.readText() }
            .also { cachedBundle = it }
    } catch (error: Exception) {
        null
    }
}

@Volatile private var cachedBundle: String? = null

private const val MERMAID_ASSET = "mermaid/mermaid.min.js"
private const val DIAGRAM_SCHEME = "helm-diagram"
private const val DIAGRAM_HEIGHT_HOST = "height"

/** A one-line diagram, plus margin, so nothing renders at zero and vanishes. */
private const val MIN_HEIGHT_DP = 64

/** Enough for a tall flowchart; past this the reader scrolls the page, not the diagram. */
private const val MAX_HEIGHT_DP = 1200

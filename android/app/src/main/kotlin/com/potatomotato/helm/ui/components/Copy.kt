package com.potatomotato.helm.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSize

/**
 * Copy-to-clipboard, the one way the whole app does it.
 *
 * One helper rather than a per-screen dance because copy now has several
 * affordances — the ⧉ on list rows, detail fields, the long-tap menu on a chat
 * bubble — and they must all behave identically: text on the primary clip, then
 * a toast saying so. The toast is not decoration; a copy's whole point is to be
 * pasted somewhere else, so a silent one is indistinguishable from a dead tap.
 *
 * The toast string is resolved at composition, never inside the returned
 * callback: stringResource reads the composition, and a click handler is no
 * longer inside it — the same reason log export resolves its strings before
 * launching its coroutine in HelmHome.
 */
@Composable
fun rememberCopy(): (String) -> Unit {
    val context = LocalContext.current
    val copied = stringResource(R.string.copy_toast)
    return remember(context, copied) { { text -> copyText(context, text, copied) } }
}

private fun copyText(context: Context, text: String, toast: String) {
    context.getSystemService(ClipboardManager::class.java)
        ?.setPrimaryClip(ClipData.newPlainText(COPY_CLIP_LABEL, text))
    Toast.makeText(context, toast, Toast.LENGTH_SHORT).show()
}

/** Clip label, not user-visible copy; the toast is what the user reads. */
private const val COPY_CLIP_LABEL = "Helm"

/**
 * The ⧉ button itself, for any surface that has one copyable thing: a list row's
 * reference, a detail field, an artifact body.
 *
 * A full touch target even though the glyph is small: copy sits beside bigger
 * controls (a pill, a chevron) and a thumb-sized miss reads as a broken row. The
 * description lives on the glyph, which the clickable merges — the glyph alone
 * says nothing to a screen reader.
 */
@Composable
fun CopyGlyphButton(text: String, modifier: Modifier = Modifier) {
    val copy = rememberCopy()
    GlyphButton(
        glyph = stringResource(R.string.copy_glyph),
        description = stringResource(R.string.copy_content_description),
        onClick = { copy(text) },
        modifier = modifier,
    )
}

/** A full-touch-target text glyph that acts — the shape the ⧉ copy button set. */
@Composable
fun GlyphButton(glyph: String, description: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .size(HelmSize.TouchTarget)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = glyph,
            color = HelmColors.Dim,
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.semantics { contentDescription = description },
        )
    }
}

package com.potatomotato.helm.ui.components

import android.content.ActivityNotFoundException
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import com.potatomotato.helm.R
import com.potatomotato.helm.log.HelmLog
import com.potatomotato.helm.ui.artifacts.LinkRules
import com.potatomotato.helm.ui.artifacts.MarkdownRules
import com.potatomotato.helm.ui.artifacts.MdBlock
import com.potatomotato.helm.ui.artifacts.MdSpan
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmRadius
import com.potatomotato.helm.ui.theme.HelmSpacing
import com.potatomotato.helm.ui.theme.HelmType

/**
 * The one way this app draws markdown.
 *
 * It lives here rather than inside the artifact screen because plan prose is the
 * SAME KIND of content as an artifact — written by an agent, read on a phone —
 * and invariant 9 says untrusted content goes through the contained path. Two
 * renderers would mean two answers to "what is allowed to render", and the second
 * one is always the one that forgets something. [MarkdownRules] still owns what
 * the subset IS; this file only says how each block looks.
 */

/**
 * A whole document as a plain (non-lazy) column.
 *
 * Non-lazy on purpose: the callers here are short prose fields that already sit
 * inside someone else's scroller, and a nested lazy list inside a lazy list
 * either collapses to nothing or fights the outer scroll. The artifact screen,
 * whose documents are long and are the whole screen, keeps its own LazyColumn and
 * calls [MarkdownBlock] per item.
 */
@Composable
fun MarkdownText(markdown: String, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(HelmSpacing.Sm),
    ) {
        MarkdownRules.blocks(markdown).forEach { block -> MarkdownBlock(block) }
    }
}

/** One parsed block, styled. */
@Composable
fun MarkdownBlock(block: MdBlock) {
    when (block) {
        is MdBlock.Image -> InlineImage(block)
        is MdBlock.Heading -> Text(
            text = block.text,
            color = HelmColors.Txt,
            style = if (block.level <= 2) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,
        )

        is MdBlock.Paragraph -> Text(
            text = annotate(block.spans),
            color = HelmColors.Txt,
            style = MaterialTheme.typography.bodyMedium,
        )

        is MdBlock.Bullet -> Row {
            Text(
                text = BULLET_GLYPH,
                color = HelmColors.Faint,
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                text = annotate(block.spans),
                color = HelmColors.Txt,
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        is MdBlock.Quote -> Text(
            text = annotate(block.spans),
            color = HelmColors.Dim,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(start = HelmSpacing.Lg),
        )

        is MdBlock.Code -> Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(HelmRadius.Sm))
                .background(HelmColors.Surface2)
                .padding(HelmSpacing.Md),
        ) {
            block.lines.forEach { line ->
                Text(
                    text = line.ifEmpty { " " },
                    color = HelmColors.Terminal,
                    style = HelmType.Terminal,
                )
            }
        }

        MdBlock.Rule -> Hairline()
    }
}

@Composable
private fun InlineImage(image: MdBlock.Image) {
    val bytes = try { Base64.decode(image.source.substringAfter(','), Base64.DEFAULT) } catch (_: IllegalArgumentException) { null }
    val bitmap = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
    if (bitmap == null) {
        Text(
            text = image.alt.ifBlank { stringResource(R.string.markdown_image_unavailable) },
            color = HelmColors.Faint,
            style = MaterialTheme.typography.bodySmall,
        )
    } else {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = image.alt.ifBlank { null },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * Plain text, except that the URLs in it are tappable.
 *
 * For the surfaces that deliberately do NOT render markdown — a chat bubble, a
 * context body — where a link is still the one thing worth following. It reuses
 * [annotate], so a link here opens exactly the way a link in an artifact does,
 * and it reuses [MarkdownRules.linksOnly], so markdown markers around it stay
 * literal characters rather than quietly gaining a second renderer.
 */
@Composable
fun LinkedText(
    text: String,
    color: Color,
    style: TextStyle,
    modifier: Modifier = Modifier,
) {
    Text(
        text = annotate(MarkdownRules.linksOnly(text)),
        color = color,
        style = style,
        modifier = modifier,
    )
}

/**
 * The subset's spans become styles, and an allowed link becomes a jump.
 *
 * Allowed is [LinkRules]' word: an agent writes these targets, and invariant 9
 * says that content is untrusted, so only the schemes on its allow-list are
 * handed to the system resolver. A refused target renders as PLAIN text — not
 * accent, not underlined — because styling a link the phone will not follow
 * advertises a tap that does nothing.
 *
 * Opening goes through the platform's own handler, which shows the user's
 * resolver; a device with nothing able to open the URL throws, and a dead tap is
 * the honest outcome there — better than a crash on someone's phone.
 */
@Composable
private fun annotate(spans: List<MdSpan>): AnnotatedString {
    val uriHandler = LocalUriHandler.current
    val linkStyles = TextLinkStyles(
        style = SpanStyle(color = HelmColors.Accent, textDecoration = TextDecoration.Underline),
    )
    return buildAnnotatedString {
        for (span in spans) {
            when (span) {
                is MdSpan.Text -> append(span.text)
                is MdSpan.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(span.text) }
                is MdSpan.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(span.text) }
                is MdSpan.CodeSpan -> withStyle(
                    SpanStyle(fontFamily = FontFamily.Monospace, background = HelmColors.Surface2),
                ) { append(span.text) }

                is MdSpan.Link -> {
                    val url = LinkRules.resolve(span.target)
                    if (url == null) {
                        append(span.text)
                    } else {
                        withLink(
                            LinkAnnotation.Url(url, linkStyles) {
                                try {
                                    uriHandler.openUri(url)
                                } catch (error: IllegalArgumentException) {
                                    HelmLog.w("markdown", "no app could open a link")
                                } catch (error: ActivityNotFoundException) {
                                    HelmLog.w("markdown", "no app could open a link")
                                }
                            },
                        ) { append(span.text) }
                    }
                }
            }
        }
    }
}

private const val BULLET_GLYPH = "•  "

package com.potatomotato.helm.ui.chat

import com.potatomotato.helm.data.CacheStage
import com.potatomotato.helm.data.HelmSession
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.potatomotato.helm.R
import com.potatomotato.helm.ui.theme.HelmColors
import com.potatomotato.helm.ui.theme.HelmSpacing
import kotlinx.coroutines.delay

/**
 * The prompt-cache line above the thread: orange past the short cache, red
 * past the long one (the desktop is about to freeze it), blue once frozen —
 * with the way out. Re-reads the clock each minute.
 */
@Composable
fun CacheBanner(session: HelmSession, onUnfreeze: () -> Unit) {
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(60_000); now = System.currentTimeMillis() } }
    val (text, color) = when (session.cacheStage(now)) {
        CacheStage.Fresh -> return
        CacheStage.Warn -> stringResource(R.string.cache_banner_warn, session.cacheWarnMinutes) to HelmColors.CacheWarn
        CacheStage.Expired -> stringResource(R.string.cache_banner_expired, session.cacheExpireMinutes) to HelmColors.CacheExpired
        CacheStage.Frozen -> stringResource(R.string.cache_banner_frozen) to HelmColors.Frozen
    }
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = HelmSpacing.Gutter, vertical = HelmSpacing.Xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = text, color = color, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
        if (session.frozen) BubbleAction(R.string.chat_unfreeze_glyph, R.string.chat_unfreeze, HelmColors.Frozen, onUnfreeze)
    }
}

package com.potatomotato.helm.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.potatomotato.helm.data.SessionEta
import com.potatomotato.helm.ui.sessions.SessionRowText
import kotlinx.coroutines.delay

@Composable
internal fun rememberEtaNow(etas: List<SessionEta>): Long {
    var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(etas) {
        while (true) {
            val current = System.currentTimeMillis()
            val nextTransition = SessionRowText.nextEtaTransitionAt(etas, current)
            val nextTick = nextTransition ?: current + (60_000L - current % 60_000L)
            delay((nextTick - current).coerceAtLeast(1L))
            nowMs = System.currentTimeMillis()
        }
    }
    return nowMs
}

package com.potatomotato.helm.ui

import com.potatomotato.helm.log.HelmLog

/**
 * The quit half of the exit dialog, as one step the tests can own.
 *
 * Quit means QUIT. The foreground service outlives the activity by design when
 * backgrounding, so finishing alone leaves the link and its notification
 * running — observed as "quit doesn't work" with Helm still online on the
 * desktop afterwards. LAN is the same story but sneakier: it lives in
 * HelmPairing, not the service, and its non-daemon pump thread keeps the whole
 * process — and the socket — alive after finish(). That is why the stops come
 * before the finish, in this order.
 *
 * WHY lambdas rather than a Context: the three steps live in three different
 * owners (HelmPairing, HelmLinkService, the Activity), and this must test on
 * the JVM like the rest of the logic-only suite — a Context would drag Android
 * types in. The call site owns the wiring; this file owns the ORDER and the
 * guarantee that finish() always runs.
 *
 * Each stop is individually try-caught, log-and-continue: a stop that throws
 * must not strand the user with a half-quit that still shows the notification,
 * and must never skip the finish that closes the UI.
 */
fun quitHelmApp(stopLan: () -> Unit, stopLinkService: () -> Unit, finish: () -> Unit) {
    try {
        stopLan()
    } catch (e: Exception) {
        HelmLog.w(HelmLog.UI, "LAN stop failed during quit", e)
    }
    try {
        stopLinkService()
    } catch (e: Exception) {
        HelmLog.w(HelmLog.UI, "link service stop failed during quit", e)
    }
    finish()
}

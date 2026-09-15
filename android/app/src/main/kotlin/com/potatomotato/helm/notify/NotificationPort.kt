package com.potatomotato.helm.notify

/**
 * The notification surface, as a port.
 *
 * Same split as [com.potatomotato.helm.ble.GattPeripheral] and
 * [com.potatomotato.helm.voice.SpeechEngine], for the same reason: the sequences
 * that actually break this — an alert arriving for the session already on screen,
 * a session buzzing ten times, an alert whose channel moved — cannot be produced
 * on demand against a real NotificationManager, and none of them need one.
 *
 * The implementation is [AndroidNotifications]; everything that DECIDES anything
 * is in [AlertRouter].
 */
interface NotificationPort {

    /** Show [alert], replacing whatever this row was showing. */
    fun post(alert: Alert)

    /**
     * Take down this row, if it is showing. The row is named by the whole
     * [Alert] — not just its session — because one session can now hold several
     * rows, one per artifact, and taking down the session would not know which.
     */
    fun cancel(alert: Alert)
}

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

    /** Show [alert], replacing whatever this session was showing. */
    fun post(alert: Alert)

    /** Take down this session's notification, if it has one. */
    fun cancel(sessionId: String)
}

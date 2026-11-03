package com.potatomotato.helm.voice

/** Where a call's audio goes. Order is the picker's order on the call screen. */
enum class AudioRoute { Earpiece, Speaker, Bluetooth, WiredHeadset }

/**
 * The route a call should be on, given what the phone can reach right now.
 *
 * A route still available is kept — the user may have chosen it. Otherwise
 * Bluetooth first (in the car, the car IS the phone), then the earpiece, then
 * the speaker for a tablet that has no earpiece. This is the one decision in
 * the audio path, so it lives here, out of [VoiceCallService]'s wiring.
 */
fun pickAudioRoute(current: AudioRoute?, available: Set<AudioRoute>): AudioRoute = when {
    current != null && current in available -> current
    AudioRoute.Bluetooth in available -> AudioRoute.Bluetooth
    AudioRoute.Earpiece in available -> AudioRoute.Earpiece
    else -> AudioRoute.Speaker
}

/**
 * The route the call should be moved to, or null to leave it. A route the user
 * [chosen] by hand sticks — at the face, and when Bluetooth connects — for as
 * long as it is there; with none chosen the sensor decides ([proximityRoute]).
 */
fun wantedRoute(chosen: AudioRoute?, near: Boolean?, available: Set<AudioRoute>): AudioRoute? =
    if (chosen != null) chosen.takeIf { it in available } else near?.let { proximityRoute(it, available) }

/**
 * The route the proximity sensor asks for: earpiece at the face, speaker away
 * from it. Null leaves the route alone — Bluetooth or a wired headset is where
 * the user's ears already are, and a phone with no earpiece has nowhere to go.
 */
fun proximityRoute(near: Boolean, available: Set<AudioRoute>): AudioRoute? = when {
    AudioRoute.Bluetooth in available || AudioRoute.WiredHeadset in available -> null
    near -> AudioRoute.Earpiece.takeIf { it in available }
    else -> AudioRoute.Speaker.takeIf { it in available }
}

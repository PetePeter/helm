package com.potatomotato.helm.voice

/** Where a call's audio goes. Order is the picker's order on the call screen. */
enum class AudioRoute { Earpiece, Speaker, Bluetooth }

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

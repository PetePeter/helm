package com.potatomotato.helm.voice

/**
 * Android's call system (Telecom), as one call needs it. Every Helm call is
 * registered there, so the car, a headset and the system treat it as a call:
 * they can hang it up and mute it, and a real phone call is arbitrated against
 * it. A port, so [CallController]'s rules run in a JVM test.
 */
interface CallLine {
    /**
     * Register a call the user is starting. A refusal known at once is
     * returned; otherwise null, and [answer] runs once, on the main thread,
     * when the system has taken the call (true) or failed to (false).
     */
    fun place(answer: (ready: Boolean) -> Unit): CallRefusal?

    /** The call is up: the car shows it as active. */
    fun active()

    /** Our call is over: end the system's with it. Idempotent. */
    fun end()
}

/** Why the system would not take a call. No call starts without it. */
enum class CallRefusal {
    /** Another call — a phone call, another app's, or one of ours — is in the way. */
    Busy,

    /** Anything else: the permission, the phone, or Telecom itself. */
    Unavailable,
}

/**
 * The phone's own microphone mute. The ONE mute state of a call: the Mute
 * button, a car screen and the system call UI all flip this same switch, so
 * they can never disagree about whether the user is muted.
 */
interface MicSwitch {
    var muted: Boolean
}

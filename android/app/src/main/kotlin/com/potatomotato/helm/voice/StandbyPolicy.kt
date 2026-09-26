package com.potatomotato.helm.voice

/**
 * When the microphone may come back on by itself. Pure, so the rule the user
 * relies on — "hung up means the mic is off" — is pinned by tests rather than
 * by reading [VoiceCallService].
 */
internal object StandbyPolicy {
    /**
     * The target to go back to "Hey Helm" standby for when a call ends, or null
     * to stop the service and free the mic: only with the switch still on.
     */
    fun resumeAfter(heyHelmOn: Boolean, target: String?): String? =
        if (heyHelmOn) target else null
}

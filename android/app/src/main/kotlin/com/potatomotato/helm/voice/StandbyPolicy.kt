package com.potatomotato.helm.voice

/**
 * When the microphone may come back on by itself. Pure, so the rule the user
 * relies on — "hung up means the mic is off" — is pinned by tests rather than
 * by reading [VoiceCallService].
 */
internal object StandbyPolicy {
    /**
     * The target to go back to "Hey Helm" standby for when a controller ends,
     * or null to stop the service and free the mic. Only a CALL ending with the
     * switch on comes back; standby ending (switched off, fatal error) never does.
     */
    fun resumeAfter(wasStandby: Boolean, heyHelmOn: Boolean, target: String?): String? =
        if (wasStandby || !heyHelmOn) null else target
}

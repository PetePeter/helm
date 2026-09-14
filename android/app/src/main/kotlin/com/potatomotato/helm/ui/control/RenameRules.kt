package com.potatomotato.helm.ui.control

/**
 * What a proposed session name must pass before the rename dialog may fire.
 *
 * Pure on purpose, like [com.potatomotato.helm.ui.sessions.SessionRows]: the
 * failure modes (a blank confirm that fires, a no-op rename spending a wire
 * call, a name the desktop would refuse) are logic, not layout, and they test
 * on the JVM. The desktop's dispatcher rejects an empty name and clamps at
 * [MAX_LENGTH] characters, so a longer one would be a certain denial — better
 * to keep the confirm dark and say why.
 */
object RenameRules {

    /** The desktop refuses a longer name; asking for one is a certain denial. */
    const val MAX_LENGTH = 50

    sealed interface Verdict {
        /** Sendable as entered. */
        data object Ok : Verdict

        /** Nothing to send — the field is empty or whitespace. */
        data object Blank : Verdict

        /** A no-op: the candidate is the current name, trimmed. */
        data object Unchanged : Verdict

        /** Past the desktop's clamp; Helm would refuse it. */
        data object TooLong : Verdict
    }

    /**
     * Judge a candidate against the current name. Whitespace is trimmed before
     * every check — the wire should carry what the user meant, not their
     * trailing spaces.
     */
    fun judge(currentName: String, candidate: String): Verdict {
        val trimmed = candidate.trim()
        return when {
            trimmed.isEmpty() -> Verdict.Blank
            trimmed == currentName -> Verdict.Unchanged
            trimmed.length > MAX_LENGTH -> Verdict.TooLong
            else -> Verdict.Ok
        }
    }

    /** The one question the dialog's confirm button asks. */
    fun renamable(currentName: String, candidate: String): Boolean =
        judge(currentName, candidate) == Verdict.Ok
}

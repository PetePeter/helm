package com.potatomotato.helm.data

/**
 * What a phone-authored artifact may be, and what it may not.
 *
 * Pure on purpose, like [RenameRules]: a blank create that fires, a no-op
 * revision spending a wire call, and a body too big for the link are logic, not
 * layout, and they test on the JVM. Both the editor (ui/artifacts) and the
 * client (link/) read these rules, which is why they live here rather than with
 * a screen.
 *
 * ## The size rule
 *
 * A body the phone authors rides OUT on the same SecureChannel the desktop caps
 * its answers with — `MAX_FRAME_BYTES` is 128KiB and an outbound frame past it
 * kills the link (the one failure this app is worst at, because it looks like
 * the radio, not the ask). The desktop's own budget arithmetic
 * (`ARTIFACT_INLINE_MAX_ESCAPED_BYTES`, src/session/artifact-download.ts) is the
 * twin of this one: frame minus wrapper headroom, measured on the JSON-ESCAPED
 * form, because a quote doubles and a control character costs 6 bytes. The
 * estimate in [escapedLength] is deliberately generous against org.json's real
 * escaping — under-counting is the only direction that fails loudly.
 */
object ArtifactRules {

    /**
     * The desktop puts no cap on a title; this one is a phone-width sanity cap
     * so a row label cannot scroll forever. The desktop accepts anything, so a
     * longer title is not a denial — the editor just refuses to author one.
     */
    const val MAX_TITLE_LENGTH = 80

    /** The secure channel's frame ceiling — MAX_FRAME_BYTES on the desktop. */
    private const val FRAME_BYTES = 128 * 1024

    /** The same wrapper headroom the desktop's budgets leave. */
    private const val WRAPPER_HEADROOM_BYTES = 2 * 1024

    /** Room for the call record AROUND the body: envelope, method, keys, id. */
    private const val CALL_RECORD_ALLOWANCE_BYTES = 1024

    /**
     * The wire budget for one authored artifact, counted over the ESCAPED
     * lengths of title and body together.
     */
    val MAX_EDIT_ESCAPED_BYTES = FRAME_BYTES - WRAPPER_HEADROOM_BYTES - CALL_RECORD_ALLOWANCE_BYTES

    sealed interface Verdict {
        /** Sendable as entered. */
        data object Ok : Verdict

        /** A create with nothing to call it — the field is empty or whitespace. */
        data object Blank : Verdict

        /** Past this phone's title cap. */
        data object TooLong : Verdict

        /** A no-op: same title, same body (trimmed), nothing staged. */
        data object Unchanged : Verdict

        /** Title and body together would not fit the link's frames. */
        data object TooLarge : Verdict
    }

    /** The title the wire carries: what the user meant, not their trailing spaces. */
    fun title(candidate: String): String = candidate.trim()

    /**
     * Whether title and body TOGETHER fit the link's frames. The size check on
     * its own, because the client needs exactly this one — a create that arrives
     * here with a blank title is the editor's missed call, and telling the user
     * "it would not fit" about it would be a lie.
     */
    fun fitsCreate(candidateTitle: String, content: String): Boolean =
        escapedLength(title(candidateTitle)) + escapedLength(content) <= MAX_EDIT_ESCAPED_BYTES

    /** Judge a new artifact's title and body. An EMPTY body is a valid note. */
    fun judgeCreate(candidateTitle: String, content: String): Verdict {
        val trimmed = title(candidateTitle)
        return when {
            trimmed.isEmpty() -> Verdict.Blank
            trimmed.length > MAX_TITLE_LENGTH -> Verdict.TooLong
            !fitsCreate(trimmed, content) -> Verdict.TooLarge
            else -> Verdict.Ok
        }
    }

    /**
     * One revise as the editor holds it: what the artifact showed when the
     * editor opened, and what the user has now. Only the fields that CHANGED
     * ride the wire — an unchanged body would append a duplicate version, and
     * an unchanged title is a rename to itself.
     */
    data class Revision(
        val shownTitle: String,
        val shownBody: String,
        val candidateTitle: String,
        val candidateBody: String,
    ) {
        /** The trimmed new title, or null when the name is unchanged. */
        val newTitle: String? get() = title(candidateTitle).takeIf { it != title(shownTitle) }

        /** The new body, or null when it matches the shown one (trim-insensitive). */
        val newBody: String? get() = candidateBody.takeIf { it.trim() != shownBody.trim() }

        /** Whether the text half of the revise has anything to send. */
        val changesText: Boolean get() = newTitle != null || newBody != null
    }

    /** Whether the changed fields of a revise fit the link's frames together. */
    fun fitsRevise(revision: Revision): Boolean =
        fitsCreate(revision.newTitle ?: "", revision.newBody ?: "")

    /**
     * Judge a revise. The title obeys the create rules; the revise is a no-op
     * (kept dark, the way rename keeps an unchanged name dark) only when the
     * title and body are unchanged AND no files are staged to ride it.
     */
    fun judgeRevision(revision: Revision, hasStaged: Boolean): Verdict {
        val trimmed = title(revision.candidateTitle)
        return when {
            trimmed.isEmpty() -> Verdict.Blank
            trimmed.length > MAX_TITLE_LENGTH -> Verdict.TooLong
            !revision.changesText && !hasStaged -> Verdict.Unchanged
            !fitsRevise(revision) -> Verdict.TooLarge
            else -> Verdict.Ok
        }
    }

    /** The one question the create form's submit asks. */
    fun sendableCreate(candidateTitle: String, content: String): Boolean =
        judgeCreate(candidateTitle, content) == Verdict.Ok

    /**
     * The JSON-escaped byte length of one string, estimated GENEROUSLY: every
     * control character and 0x7f is charged the 6-byte `\uXXXX` worst case
     * (org.json may emit the 2-char short form), a quote or backslash doubles,
     * a surrogate pair is charged two 3-byte chars (it encodes to 4), and
     * everything else is its UTF-8 length.
     */
    fun escapedLength(text: String): Int = text.sumOf { c ->
        when {
            c.code < 0x20 || c.code == 0x7f -> 6
            c == '"' || c == '\\' -> 2
            else -> utf8Length(c)
        }
    }

    private fun utf8Length(c: Char): Int =
        when {
            c.code < 0x80 -> 1
            c.code < 0x800 -> 2
            else -> 3
        }
}

package com.potatomotato.helm.crypto

/**
 * protocol-version — the compatibility gate, ported from
 * `src/mobile/protocol-version.ts`.
 *
 * Helm auto-updates on the desktop while the APK is sideloaded, so the two
 * product versions drift constantly. Each side declares a supported RANGE and
 * the highest common version wins; product versions are exchanged only so a
 * refusal can name something a human recognises.
 *
 * RULE: any breaking wire change bumps [ProtocolVersion.MAX] on BOTH sides in
 * the same commit, and adds a row to the table in docs/mobile-secure-channel.md.
 */
object ProtocolVersion {
    /** Oldest wire protocol this build can still speak. */
    const val MIN = 1

    /** Newest wire protocol this build speaks. */
    const val MAX = 1

    /** A version beyond this is corruption, not a future build. */
    private const val ABSURD = 4096

    val LOCAL_RANGE = ProtocolRange(MIN, MAX)

    /**
     * Validate an untrusted pair of endpoints. Returns null for anything
     * malformed — never a default, because defaulting garbage to 0 or to MAX
     * turns a corrupt frame into a silently accepted session.
     */
    fun parseRange(min: Long, max: Long): ProtocolRange? {
        if (!isVersion(min) || !isVersion(max) || min > max) return null
        return ProtocolRange(min.toInt(), max.toInt())
    }

    /** Pick the highest version both ranges contain, or explain why there is none. */
    fun negotiate(
        local: ProtocolRange,
        peer: ProtocolRange,
        labels: ProtocolLabels,
    ): Negotiation {
        if (parseRange(local.min.toLong(), local.max.toLong()) == null ||
            parseRange(peer.min.toLong(), peer.max.toLong()) == null
        ) {
            return Negotiation.Refused(RefusalCode.MALFORMED_RANGE, malformedMessage(labels))
        }

        val version = minOf(local.max, peer.max)
        if (version >= maxOf(local.min, peer.min)) return Negotiation.Agreed(version)

        val ranges = "${labels.local} speaks protocol ${describe(local)}; " +
            "${labels.peer} speaks ${describe(peer)}."
        return if (peer.max < local.min) {
            Negotiation.Refused(
                RefusalCode.PEER_TOO_OLD,
                "${capitalize(labels.peer)} is too old for this version of ${labels.local}. " +
                    "$ranges Update ${labels.peer}.",
            )
        } else {
            Negotiation.Refused(
                RefusalCode.PEER_TOO_NEW,
                "${capitalize(labels.local)} is too old for this version of ${labels.peer}. " +
                    "$ranges Update ${labels.local}.",
            )
        }
    }

    fun malformedMessage(labels: ProtocolLabels): String =
        "${labels.peer} sent an unusable protocol range. Reinstall ${labels.peer}."

    private fun isVersion(value: Long): Boolean = value in 1..ABSURD.toLong()

    private fun describe(range: ProtocolRange): String =
        if (range.min == range.max) "${range.min}" else "${range.min}–${range.max}"

    private fun capitalize(text: String): String =
        if (text.isEmpty()) text else text[0].uppercaseChar() + text.substring(1)
}

data class ProtocolRange(val min: Int, val max: Int)

/** How each side is named in a refusal message, from THIS side's point of view. */
data class ProtocolLabels(val local: String, val peer: String) {
    companion object {
        /** The phone's view: Helm is the peer. */
        val PHONE = ProtocolLabels(local = "the phone app", peer = "Helm")
    }
}

/**
 * A refusal code is ALWAYS relative to whoever holds it: PEER_TOO_OLD means "the
 * other end is the old one". It goes on the wire from the refuser's point of
 * view and is inverted on receipt, so neither side reasons about perspective.
 * The human message travels alongside and names both sides, so it never inverts.
 */
enum class RefusalCode(val wire: String) {
    PEER_TOO_OLD("peer-too-old"),
    PEER_TOO_NEW("peer-too-new"),
    MALFORMED_RANGE("malformed-range"),
    ;

    /** Flip between the two peers' points of view. */
    fun inverted(): RefusalCode = when (this) {
        PEER_TOO_OLD -> PEER_TOO_NEW
        PEER_TOO_NEW -> PEER_TOO_OLD
        MALFORMED_RANGE -> MALFORMED_RANGE
    }

    companion object {
        /** Anything unrecognised is corruption, and corruption is malformed. */
        fun fromWire(code: String): RefusalCode =
            entries.firstOrNull { it.wire == code } ?: MALFORMED_RANGE
    }
}

sealed interface Negotiation {
    data class Agreed(val version: Int) : Negotiation
    data class Refused(val code: RefusalCode, val message: String) : Negotiation
}

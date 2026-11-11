package com.potatomotato.helm.ui.plans

/**
 * Drag-a-plan-to-another-lane rules, kept out of Compose so they are testable.
 * A lane's drop zone is its header plus every row under it, so a finger
 * anywhere in a lane's section lands there — not just on the thin header.
 */
object LaneDrop {
    /** One visible board item in viewport pixels; lane headers are keyed "lane:<laneKey>". */
    data class Item(val key: String, val top: Int, val height: Int)

    const val UNGROUPED = "ungrouped"
    const val HEADER_PREFIX = "lane:"

    /** The lane key whose section holds [y], or null when no visible header is at or above it. */
    fun laneAt(items: List<Item>, y: Float): String? =
        items.lastOrNull { it.key.startsWith(HEADER_PREFIX) && it.top <= y }?.key?.removePrefix(HEADER_PREFIX)

    /** The sequence id a lane key stands for; the ungrouped bucket is no sequence. */
    fun sequenceIdOf(laneKey: String): String? = laneKey.takeUnless { it == UNGROUPED }

    fun isMove(currentSequenceId: String?, targetLane: String): Boolean = currentSequenceId != sequenceIdOf(targetLane)
}

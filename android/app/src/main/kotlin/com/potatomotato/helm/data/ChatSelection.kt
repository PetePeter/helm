package com.potatomotato.helm.data

/**
 * The chat selection bar's "Select range": every row between the first and the
 * last selected one, inclusive, in THREAD order — so a range picked by tapping
 * the bottom row first still covers the rows in between. Keys no longer in the
 * thread are ignored; fewer than one selected row in the thread selects nothing
 * new.
 */
fun rangeSelection(threadKeys: List<String>, selected: Set<String>): Set<String> {
    val positions = threadKeys.withIndex().filter { it.value in selected }.map { it.index }
    if (positions.isEmpty()) return selected
    return selected + threadKeys.subList(positions.first(), positions.last() + 1)
}

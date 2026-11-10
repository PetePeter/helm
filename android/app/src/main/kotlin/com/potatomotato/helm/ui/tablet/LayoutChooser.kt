package com.potatomotato.helm.ui.tablet

/** Responsive session shell selected from the current available window width. */
internal enum class TabletLayout {
    Phone,
    Collapsed,
    Expanded,
}

internal object LayoutChooser {
    const val COLLAPSED_MIN_WIDTH_DP = 600
    const val EXPANDED_MIN_WIDTH_DP = 840

    fun forWidth(widthDp: Int): TabletLayout = when {
        widthDp < COLLAPSED_MIN_WIDTH_DP -> TabletLayout.Phone
        widthDp < EXPANDED_MIN_WIDTH_DP -> TabletLayout.Collapsed
        else -> TabletLayout.Expanded
    }

    /**
     * Ask for landscape only on tablets. Keyed on the smallest side, not the longest:
     * tall phones (e.g. 406x904dp) have a long side past the expanded width but are phones.
     */
    fun shouldPreferLandscape(smallestWidthDp: Int): Boolean =
        smallestWidthDp >= COLLAPSED_MIN_WIDTH_DP
}

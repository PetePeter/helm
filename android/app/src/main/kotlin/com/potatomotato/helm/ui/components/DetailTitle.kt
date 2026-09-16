package com.potatomotato.helm.ui.components

/**
 * What a detail screen's app bar calls the thing it has open.
 *
 * A detail screen is entered BEFORE its record arrives, and it may never arrive
 * at all — so the bar has to name something on the first frame. Naming the kind
 * ("Plan") is the honest answer while the ask is in flight or has failed, and
 * the record's own title replaces it the moment there is one.
 *
 * A record that arrived with a blank title falls back too: an app bar with an
 * empty title reads as a rendering bug, not as an untitled record.
 *
 * Pure Kotlin, no Compose, because that choice is a rule and rules belong
 * somewhere a JVM test can pin them.
 */
fun <T> detailTitle(view: LoadView<T>, fallback: String, titleOf: (T) -> String): String =
    when (view) {
        is LoadView.Ready -> titleOf(view.data).ifBlank { fallback }
        LoadView.Loading, is LoadView.Failed -> fallback
    }

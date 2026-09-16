package com.potatomotato.helm.data

/**
 * One row on the desktops screen.
 *
 * [linked] is derived, never stored: the phone is a peripheral and the desktop
 * is the central, so which pairing is live is a fact about the radio right now,
 * not about anything on disk.
 */
data class PairedDesktop(
    val machineId: String,
    val label: String,
    val linked: Boolean,
)

/**
 * A name for a desktop the user has not named.
 *
 * The full machineId is a UUID — unreadable, and identical-looking across rows
 * until the eye reaches the differing character. The leading block is what
 * actually distinguishes two desktops at a glance, so that is what is shown.
 */
fun defaultDesktopLabel(machineId: String): String = "desktop-" + machineId.take(SHORT_ID_LENGTH)

/**
 * The paired desktops, as the screen shows them.
 *
 * Driven from [PskStore.pairedMachineIds] alone: the PSK is the only thing that
 * makes a pairing real, so a nickname with no key behind it is ignored rather
 * than resurrected as a row that cannot connect.
 *
 * The live desktop sorts first because it is the one answer the user opened the
 * screen for; the rest sort by name so the order does not shuffle between visits.
 */
fun pairedDesktops(store: PskStore, linkedMachineId: String?): List<PairedDesktop> =
    store.pairedMachineIds()
        .map { machineId ->
            PairedDesktop(
                machineId = machineId,
                label = store.label(machineId)?.takeIf { it.isNotBlank() } ?: defaultDesktopLabel(machineId),
                linked = machineId == linkedMachineId,
            )
        }
        .sortedWith(compareByDescending<PairedDesktop> { it.linked }.thenBy { it.label.lowercase() })

private const val SHORT_ID_LENGTH = 8

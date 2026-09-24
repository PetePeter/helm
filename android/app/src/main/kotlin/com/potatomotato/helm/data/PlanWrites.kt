package com.potatomotato.helm.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.atomic.AtomicLong

/** Every plan/sequence write the phone can make (P-0812). One per desktop tool, plus the two-step cleanup. */
enum class PlanWriteKind {
    CreatePlan,
    UpdatePlan,
    SetState,
    Complete,
    Reopen,
    DeletePlan,
    AssignSequence,
    CreateSequence,
    UpdateSequence,
    DeleteSequence,
    ClearUnused,
}

/**
 * The last plan/sequence write, as the plan screens show it.
 *
 * Kept apart from [ControlRepository]'s session notices on purpose: those
 * notices are keyed by [SessionAction], whose every member is a row on the
 * session sheet, and plan writes are not session actions. [seq] makes two
 * identical outcomes two distinct values, so a screen reacting to "done" (say,
 * closing a form) fires for the second one too.
 */
sealed interface PlanWrite {
    data object Idle : PlanWrite
    data class InFlight(val kind: PlanWriteKind) : PlanWrite
    data class Done(val seq: Long, val kind: PlanWriteKind) : PlanWrite
    data class Failed(val seq: Long, val kind: PlanWriteKind, val message: String) : PlanWrite
}

/**
 * The write-state half of the plan surfaces. It holds NO plan data: a failed
 * write must leave every cache exactly as it was, and the simplest way to make
 * that true is for the failure path to touch nothing but this flow.
 */
class PlanWrites {
    private val _state = MutableStateFlow<PlanWrite>(PlanWrite.Idle)
    val state: StateFlow<PlanWrite> = _state.asStateFlow()

    private val nextSeq = AtomicLong(1)

    /** True while a write is crossing the wire — the forms grey their confirm on it (two taps are two plans). */
    val busy: Boolean get() = _state.value is PlanWrite.InFlight

    fun started(kind: PlanWriteKind) {
        _state.value = PlanWrite.InFlight(kind)
    }

    fun succeeded(kind: PlanWriteKind) {
        _state.value = PlanWrite.Done(nextSeq.getAndIncrement(), kind)
    }

    fun failed(kind: PlanWriteKind, message: String) {
        _state.value = PlanWrite.Failed(nextSeq.getAndIncrement(), kind, message)
    }

    /** The user read the verdict; stop showing it. */
    fun dismiss() {
        _state.value = PlanWrite.Idle
    }
}

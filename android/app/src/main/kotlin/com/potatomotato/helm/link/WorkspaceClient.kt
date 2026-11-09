package com.potatomotato.helm.link

import com.potatomotato.helm.data.TimeAsk
import com.potatomotato.helm.data.TimeRepository
import com.potatomotato.helm.data.CapabilityCache
import com.potatomotato.helm.data.ContextRepository
import com.potatomotato.helm.data.ControlRepository
import kotlin.coroutines.resume


class WorkspaceClient internal constructor(
    private val core: HelmClient,
    val capabilities: CapabilityCache,
    val control: ControlRepository,
    val time: TimeRepository,
    private val contexts: ContextRepository,
) {
    /**
     * Ask the gate what this device may do. The answer drives the greying on the
     * control sheet, so it is asked for rather than assumed — a hardcoded list
     * would eventually claim a permission the desktop had revoked.
     */
    fun refreshCapabilities(): Boolean = core.call(HelmClient.METHOD_MOBILE_TOOLS) { outcome ->
        // A refused or unanswered discovery leaves the surface UNKNOWN rather
        // than empty: "we could not ask" must not render as "you may not".
        if (outcome is HelmClient.Outcome.Ok) capabilities.apply(outcome.result) else capabilities.forget()
    }

    /**
     * Restart Helm on the linked desktop — the user's restart, answered in-gate
     * (`RESERVED_RESTART_HELM_METHOD`), never the AI's handover-gated tool.
     * [onOutcome] gets null on success, else the desktop's reason.
     */
    fun restartHelm(resume: Boolean, onOutcome: (String?) -> Unit): Boolean =
        core.call(HelmClient.METHOD_RESTART_HELM, linkedMapOf<String, Any>("resume" to resume)) { outcome ->
            onOutcome((outcome as? HelmClient.Outcome.Failed)?.message)
        }

    /** [sessionId]'s ring was answered here: Helm drops that session's one retry. Best-effort. */
    fun ringAnswered(sessionId: String): Boolean =
        core.call(HelmClient.METHOD_RING_ANSWERED, linkedMapOf<String, Any>("sessionId" to sessionId)) { }

    /**
     * Directories Helm knows about, for the spawn form. A failure is STATE, not
     * a log line: an unanswered fetch used to leave the form hinting "waiting
     * for the directory list" forever, which reads as patience when the truth is
     * the call already died.
     */
    fun refreshDirectories(machineId: String? = null): Boolean {
        control.directoriesRequested(machineId)
        val answer: (HelmClient.Outcome) -> Unit = { outcome ->
            // A late answer for a machine the user already left is not this list.
            if (control.wantsDirectoriesOf(machineId)) {
                when (outcome) {
                    is HelmClient.Outcome.Ok -> if (!control.directoriesArrived(outcome.result)) {
                        control.directoriesFailed(HelmClient.UNREADABLE_LIST)
                    }
                    is HelmClient.Outcome.Failed -> control.directoriesFailed(outcome.message)
                }
            }
        }
        if (machineId == null) return core.call(HelmClient.METHOD_DIRECTORY_LIST, onOutcome = answer)
        // Another machine's folders: its own directory_list, relayed by the desktop.
        // No `args`: directory_list takes none, and the desktop defaults a missing one to {}.
        val params = linkedMapOf<String, Any>("peer" to machineId, "tool" to HelmClient.METHOD_DIRECTORY_LIST)
        return core.call(HelmClient.METHOD_PEER_CALL, params, onOutcome = answer)
    }

    /**
     * The fleet peers a session can be spawned on, for the spawn form's machine
     * row. A refusal is not an error: it just means this desktop is the only choice.
     */
    fun refreshMachines(): Boolean = core.call(HelmClient.METHOD_PEER_LIST) { outcome ->
        when (outcome) {
            is HelmClient.Outcome.Ok -> if (!control.machinesArrived(outcome.result)) control.machinesUnavailable()
            is HelmClient.Outcome.Failed -> control.machinesUnavailable()
        }
    }

    /**
     * The full CLI catalogue, for the spawn form. A refused or failed call is
     * left to the form's fallback (harvesting the running sessions) rather than
     * an error state: the fallback is a real feature, not a degraded one.
     */
    fun refreshClis(machineId: String? = null): Boolean {
        control.clisRequested(machineId)
        val answer: (HelmClient.Outcome) -> Unit = { outcome ->
            // A late answer for a machine the user already left is not this list.
            if (outcome is HelmClient.Outcome.Ok && control.wantsClisOf(machineId)) control.clisArrived(outcome.result)
        }
        if (machineId == null) return core.call(HelmClient.METHOD_TOOL_LIST, onOutcome = answer)
        // Another machine's CLIs: its own catalogue, relayed like its folders.
        val params = linkedMapOf<String, Any>("peer" to machineId, "tool" to HelmClient.METHOD_TOOL_LIST)
        return core.call(HelmClient.METHOD_PEER_CALL, params, onOutcome = answer)
    }

    /**
     * The projects Helm tracks. A BARE call — `project_list` takes no arguments —
     * and the prerequisite for every context ask, since a context node is
     * addressed by its project.
     */
    fun refreshProjects(): Boolean {
        contexts.projectsRequested()
        return core.call(HelmClient.METHOD_PROJECT_LIST) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok ->
                    if (!contexts.projectsArrived(outcome.result)) {
                        contexts.projectsFailed(HelmClient.UNREADABLE_PROJECTS)
                    }
                is HelmClient.Outcome.Failed -> contexts.projectsFailed(outcome.message)
            }
        }
    }

    /**
     * The user's own statistics (docs/time-tracking.md). A phone-only gate method,
     * not an AI tool: nothing an agent can call reads this data.
     */
    fun refreshTime(ask: TimeAsk): Boolean {
        time.requested(ask)
        val params = linkedMapOf<String, Any>("view" to ask.view.wire, "period" to ask.period.wire, "anchor" to ask.anchorEpochMs)
        if (ask.view == com.potatomotato.helm.data.TimeView.Timesheet) ask.projectKey?.let { params["projectKey"] = it }
        return core.call(HelmClient.METHOD_TIMESHEET, params) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> if (!time.arrived(ask, outcome.result)) time.failed(ask, HelmClient.UNREADABLE_TIME)
                is HelmClient.Outcome.Failed -> time.failed(ask, outcome.message)
            }
        }
    }
}

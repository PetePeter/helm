package com.potatomotato.helm.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * What Helm will actually let THIS phone do.
 *
 * The answer comes from `__mobile_tools__`, the gate's reserved meta-method,
 * which intersects the tool catalogue with the device's allow-list. The control
 * sheet greys from THIS and never from a hardcoded list — the ratified divergence
 * from the desktop's uniform-deny rule is presentational only, and it is only
 * defensible while the greying reflects what the gate really says.
 *
 * [Unknown] is a distinct state, not an empty set, and the distinction is the
 * point: "not asked yet" and "asked, and you may not" must not render the same
 * way. An action the app cannot yet vouch for is offered as unavailable WITHOUT
 * the "not permitted" label, because claiming a permission verdict the phone does
 * not have is a lie the user cannot check.
 *
 * The cache is authority-free. The gate remains the only enforcement point; this
 * is a hint that can be stale by exactly one poll, and a denial arriving for a
 * permitted-looking action is a NORMAL outcome the UI must read gracefully.
 */
sealed interface Capabilities {

    /** Not asked yet, or forgotten because the link went. */
    data object Unknown : Capabilities

    /** The surface the gate last confirmed. May be empty — that is a real answer. */
    data class Known(val tools: Set<String>) : Capabilities
}

class CapabilityCache {
    private val _state = MutableStateFlow<Capabilities>(Capabilities.Unknown)
    val state: StateFlow<Capabilities> = _state.asStateFlow()

    /**
     * Take the `__mobile_tools__` result. False when the payload is not a tool
     * list at all, in which case the previous answer stands rather than being
     * replaced by a wrong one.
     */
    fun apply(result: Any?): Boolean {
        val tools = parse(result) ?: return false
        _state.value = Capabilities.Known(tools)
        return true
    }

    /**
     * Forget the answer. Called when the link drops, so a reconnect re-asks:
     * an allow-list edited on the desktop while the phone was away must not keep
     * offering a capability that was revoked.
     */
    fun forget() {
        _state.value = Capabilities.Unknown
    }

    /** Whether the gate said yes. Unknown is not a yes. */
    fun allows(tool: String): Boolean =
        (_state.value as? Capabilities.Known)?.tools?.contains(tool) == true

    private fun parse(result: Any?): Set<String>? {
        val tools = (result as? JSONObject)?.opt("tools") as? JSONArray ?: return null
        return (0 until tools.length())
            .mapNotNull { (tools.opt(it) as? JSONObject)?.opt("name") as? String }
            .toSet()
    }
}

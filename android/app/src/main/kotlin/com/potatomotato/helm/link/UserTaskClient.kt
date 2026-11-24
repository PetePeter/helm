package com.potatomotato.helm.link

import com.potatomotato.helm.data.UserTaskRepository

/** The user_task_* tools over the phone link; every write refreshes the board. */
class UserTaskClient internal constructor(
    private val core: HelmClient,
    val state: UserTaskRepository,
) {
    fun refresh(): Boolean {
        state.listRequested()
        return core.call(METHOD_LIST, linkedMapOf<String, Any>("includeDone" to true)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> if (!state.listArrived(outcome.result)) state.listFailed(UNREADABLE_TASKS)
                is HelmClient.Outcome.Failed -> state.listFailed(outcome.message)
            }
        }
    }

    fun open(id: String): Boolean = core.call(METHOD_GET, linkedMapOf<String, Any>("id" to id)) { outcome ->
        when (outcome) {
            is HelmClient.Outcome.Ok -> state.detailArrived(outcome.result)
            is HelmClient.Outcome.Failed -> state.writeFailed(outcome.message)
        }
    }

    fun openAttachment(taskId: String, attachmentId: String): Boolean =
        core.call(METHOD_GET, linkedMapOf<String, Any>("id" to taskId, "attachmentId" to attachmentId)) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> state.attachmentArrived(outcome.result)
                is HelmClient.Outcome.Failed -> state.writeFailed(outcome.message)
            }
        }

    fun add(title: String, body: String, urgent: Boolean): Boolean =
        write(METHOD_ADD, linkedMapOf("title" to title, "body" to body, "urgent" to urgent))

    fun setDone(id: String, done: Boolean): Boolean =
        write(METHOD_UPDATE, linkedMapOf("id" to id, "done" to done), reopen = id)

    fun edit(id: String, title: String, body: String, urgent: Boolean): Boolean =
        write(METHOD_UPDATE, linkedMapOf("id" to id, "title" to title, "body" to body, "urgent" to urgent), reopen = id)

    fun delete(id: String): Boolean = write(METHOD_DELETE, linkedMapOf("id" to id))

    private fun write(method: String, params: Map<String, Any>, reopen: String? = null): Boolean =
        core.call(method, params) { outcome ->
            when (outcome) {
                is HelmClient.Outcome.Ok -> {
                    refresh()
                    if (reopen != null) open(reopen)
                }
                is HelmClient.Outcome.Failed -> state.writeFailed(outcome.message)
            }
        }

    companion object {
        internal const val UNREADABLE_TASKS = "Helm answered with a task list this app could not read"
        internal const val METHOD_ADD = "user_task_add"
        internal const val METHOD_LIST = "user_task_list"
        internal const val METHOD_GET = "user_task_get"
        internal const val METHOD_UPDATE = "user_task_update"
        internal const val METHOD_DELETE = "user_task_delete"
    }
}

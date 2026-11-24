package com.potatomotato.helm.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** The checklist as user_task_get / user_task_list send it (docs/user-tasks.md). */
class UserTaskRepositoryChecklistTest {

    @Test
    fun `detail keeps checklist order and ticks, row carries progress and excerpt`() {
        val repo = UserTaskRepository()
        repo.detailArrived(JSONObject("""
            {"id":"t1","title":"Test","body":"b","author":{"kind":"user"},"urgent":false,"attachments":[],
             "checklist":[{"id":"a","text":"Install","doneAt":5},{"id":"b","text":"Scan"}],
             "createdAt":1,"updatedAt":1}
        """.trimIndent()))
        assertEquals(
            listOf(UserTaskChecklistItem("a", "Install", true), UserTaskChecklistItem("b", "Scan", false)),
            repo.details.value.getValue("t1").checklist,
        )

        repo.listArrived(JSONArray("""
            [{"id":"t1","title":"Test","urgent":false,"author":"you","attachments":0,"createdAt":1,
              "excerpt":"Validate the flow","checklist":{"done":1,"total":2}},
             {"id":"t2","title":"Plain","urgent":false,"author":"you","attachments":0,"createdAt":1}]
        """.trimIndent()))
        val rows = (repo.board.value as UserTaskBoardState.Ready).rows
        assertEquals(Triple(1, 2, "Validate the flow"), Triple(rows[0].checklistDone, rows[0].checklistTotal, rows[0].excerpt))
        assertEquals(Triple(0, 0, ""), Triple(rows[1].checklistDone, rows[1].checklistTotal, rows[1].excerpt))
    }
}

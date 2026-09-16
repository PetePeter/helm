package com.potatomotato.helm.ui.sequences

import com.potatomotato.helm.data.HelmPlanSequence
import com.potatomotato.helm.ui.components.DetailLabel
import com.potatomotato.helm.ui.components.DetailValue
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The two rules a lane's detail has beyond "skip the blanks": order 0 is a real
 * order, and membership is named the way the user has already seen it named.
 */
class SequenceFieldsTest {

    private fun lane(
        missionStatement: String = "",
        sharedMemory: String = "",
        order: Int = 0,
        contextIds: List<String> = emptyList(),
        memberPlanIds: List<String> = emptyList(),
        memberHumanIds: List<String> = emptyList(),
        dirPath: String = "X:/work/alpha",
    ) = HelmPlanSequence(
        id = "lane",
        projectId = "proj",
        dirPath = dirPath,
        title = "A lane",
        missionStatement = missionStatement,
        sharedMemory = sharedMemory,
        order = order,
        contextIds = contextIds,
        memberPlanIds = memberPlanIds,
        memberHumanIds = memberHumanIds,
    )

    private fun labels(sequence: HelmPlanSequence) = SequenceFields.of(sequence).map { it.label }

    private fun value(sequence: HelmPlanSequence, label: DetailLabel) =
        SequenceFields.of(sequence).first { it.label == label }.value

    @Test
    fun `order zero is the first lane, not a missing order`() {
        assertEquals(listOf(DetailLabel.Order, DetailLabel.Directory), labels(lane(order = 0)))
        assertEquals(DetailValue.Text("0"), value(lane(order = 0), DetailLabel.Order))
    }

    @Test
    fun `an empty mission and an empty shared memory say nothing`() {
        assertEquals(
            listOf(DetailLabel.Order, DetailLabel.Directory),
            labels(lane(missionStatement = "  ", sharedMemory = "")),
        )
    }

    @Test
    fun `membership is shown as the human ids the plan board already showed`() {
        val sequence = lane(
            memberPlanIds = listOf("uuid-1", "uuid-2"),
            memberHumanIds = listOf("P-0041", "P-0042"),
        )

        assertEquals(DetailValue.Text("P-0041, P-0042"), value(sequence, DetailLabel.Members))
    }

    @Test
    fun `without human ids the internal ids are better than nothing`() {
        val sequence = lane(memberPlanIds = listOf("uuid-1"))

        assertEquals(DetailValue.Text("uuid-1"), value(sequence, DetailLabel.Members))
    }

    @Test
    fun `a lane that answered no membership at all does not claim to be empty`() {
        assertEquals(
            listOf(DetailLabel.Order, DetailLabel.Directory),
            labels(lane(memberPlanIds = emptyList(), memberHumanIds = emptyList())),
        )
        assertEquals("", SequenceFields.members(lane()))
    }

    @Test
    fun `the full lane reads in its intended order`() {
        val sequence = lane(
            missionStatement = "Ship the transport",
            sharedMemory = "LAN preempts BLE",
            order = 2,
            contextIds = listOf("ctx-1"),
            memberHumanIds = listOf("P-0041"),
        )

        assertEquals(
            listOf(
                DetailLabel.Order,
                DetailLabel.Mission,
                DetailLabel.SharedMemory,
                DetailLabel.Members,
                DetailLabel.Contexts,
                DetailLabel.Directory,
            ),
            labels(sequence),
        )
    }
}

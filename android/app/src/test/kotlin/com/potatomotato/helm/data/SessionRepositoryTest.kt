package com.potatomotato.helm.data

import com.potatomotato.helm.ui.components.SessionState
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The list behaviour that a poll-driven surface lives or dies on.
 *
 * Nothing here asserts a colour or a composable: the mapping from wire to dot
 * STATE is real logic with a real failure mode (a dot that lies about whether
 * anything is happening), while "the four colours differ" is not a test.
 */
class SessionRepositoryTest {

    @Test
    fun `each activity level maps to the dot state that means the same thing`() {
        val parsed = SessionWire.parseList(
            listOf(
                summary("s1", activityLevel = "active"),
                summary("s2", activityLevel = "inactive"),
                summary("s3", activityLevel = "idle"),
            ).toJsonArray(),
        )!!

        assertEquals(SessionState.Active, parsed[0].activity)
        // The desktop's "inactive" is quiet-but-recently-alive: the phone's Waiting.
        assertEquals(SessionState.Waiting, parsed[1].activity)
        assertEquals(SessionState.Idle, parsed[2].activity)
    }

    @Test
    fun `an unknown or missing activity level falls back to idle instead of crashing`() {
        val parsed = SessionWire.parseList(
            listOf(
                summary("s1", activityLevel = "transcendent"),
                summary("s2", activityLevel = null),
                summary("s3", activityLevel = 7),
            ).toJsonArray(),
        )!!

        assertEquals(3, parsed.size)
        parsed.forEach { assertEquals(it.id, SessionState.Idle, it.activity) }
    }

    @Test
    fun `a session with no id is dropped rather than taking the list down with it`() {
        val array = JSONArray()
        array.put(JSONObject(mapOf("name" to "nameless")))
        array.put(summary("s1"))

        val parsed = SessionWire.parseList(array)!!
        assertEquals(listOf("s1"), parsed.map { it.id })
    }

    @Test
    fun `a payload that is not a session list is refused, not guessed at`() {
        assertNull(SessionWire.parseList(null))
        assertNull(SessionWire.parseList(JSONObject(mapOf("sessions" to "elsewhere"))))
    }

    @Test
    fun `question pending, aiagent state, last-active age and claimed plan arrive on the session`() {
        // The row sub-line, the relative time and the plan pill are drawn from
        // these; the desktop sends them on every session_list result.
        val parsed = SessionWire.parseList(
            listOf(
                JSONObject(
                    mapOf(
                        "id" to "s1",
                        "activityLevel" to "active",
                        "questionPending" to true,
                        "aiagentState" to "implementing",
                        "lastActiveAtEpochMs" to 1_700_000_000_000L,
                        "currentPlanId" to "P-0746",
                    ),
                ),
            ).toJsonArray(),
        )!!.single()

        assertTrue(parsed.questionPending)
        assertEquals("implementing", parsed.aiagentState)
        assertEquals(1_700_000_000_000L, parsed.lastActiveAtEpochMs)
        assertEquals("P-0746", parsed.currentPlanId)
    }

    @Test
    fun `the three row fields degrade to absent, never to a crash`() {
        val parsed = SessionWire.parseList(
            listOf(
                JSONObject(
                    mapOf(
                        "id" to "s1",
                        "questionPending" to "yes",
                        "aiagentState" to 7,
                        "lastActiveAtEpochMs" to "soon",
                    ),
                ),
            ).toJsonArray(),
        )!!.single()

        assertEquals(false, parsed.questionPending)
        assertNull(parsed.aiagentState)
        assertNull(parsed.lastActiveAtEpochMs)
    }

    @Test
    fun `a snapshot that changes one session leaves every other instance untouched`() {
        val repository = SessionRepository()
        repository.applySnapshot(SessionWire.parseList(listOf(summary("s1"), summary("s2")).toJsonArray())!!)
        val before = repository.sessions.value.associateBy { it.id }

        repository.applySnapshot(
            SessionWire.parseList(listOf(summary("s1"), summary("s2", activityLevel = "active")).toJsonArray())!!,
        )
        val after = repository.sessions.value.associateBy { it.id }

        // This is what makes a poll incremental: Compose re-draws the row that
        // moved and skips the one that did not.
        assertSame(before["s1"], after["s1"])
        assertNotSame(before["s2"], after["s2"])
        assertEquals(SessionState.Active, after["s2"]!!.activity)
    }

    @Test
    fun `sessions arriving in a different order produce the same list`() {
        val forwards = SessionRepository()
        val backwards = SessionRepository()
        val batch = listOf(summary("s1", name = "beta"), summary("s2", name = "alpha"), summary("s3", name = "gamma"))

        forwards.applySnapshot(SessionWire.parseList(batch.toJsonArray())!!)
        backwards.applySnapshot(SessionWire.parseList(batch.reversed().toJsonArray())!!)

        assertEquals(listOf("alpha", "beta", "gamma"), forwards.sessions.value.map { it.name })
        assertEquals(forwards.sessions.value, backwards.sessions.value)
    }

    @Test
    fun `sessions are grouped by project before they are sorted by name`() {
        val repository = SessionRepository()
        repository.applySnapshot(
            SessionWire.parseList(
                listOf(
                    summary("s1", name = "alpha", projectPath = "/repo/zebra"),
                    summary("s2", name = "omega", projectPath = "/repo/apple"),
                ).toJsonArray(),
            )!!,
        )

        assertEquals(listOf("omega", "alpha"), repository.sessions.value.map { it.name })
    }

    @Test
    fun `a session missing from the next snapshot disappears`() {
        val repository = SessionRepository()
        repository.applySnapshot(SessionWire.parseList(listOf(summary("s1"), summary("s2")).toJsonArray())!!)

        repository.applySnapshot(SessionWire.parseList(listOf(summary("s2")).toJsonArray())!!)

        assertEquals(listOf("s2"), repository.sessions.value.map { it.id })
        assertNull(repository.find("s1"))
    }

    @Test
    fun `the group label is the last path segment whichever separator the desktop used`() {
        val parsed = SessionWire.parseList(
            listOf(
                summary("s1", projectPath = "X:\\coding\\gamepad-cli-hub"),
                summary("s2", projectPath = "/home/o/helm/"),
            ).toJsonArray(),
        )!!

        assertEquals("gamepad-cli-hub", parsed[0].projectLabel)
        assertEquals("helm", parsed[1].projectLabel)
    }

    @Test
    fun `a session falls back to its working directory when it has no project path`() {
        val summary = JSONObject(mapOf("id" to "s1", "workingDir" to "/repo/main"))

        assertEquals("/repo/main", SessionWire.parseList(JSONArray().put(summary))!!.single().projectPath)
    }

    @Test
    fun `an answer moves reach to delivered, and an empty answer is still an answer`() {
        val repo = SessionRepository()
        assertEquals(Reach.Never, repo.reach.value)

        // The empty case is the one that matters: it is the ONLY thing that
        // earns the right to say "no sessions are running on this desktop".
        repo.applySnapshot(emptyList())

        assertEquals(Reach.Delivered, repo.reach.value)
    }

    @Test
    fun `a flood of identical denials is one state change, not forty`() {
        // The user's phone refused session_list 40+ times in a row. That must
        // settle into ONE calm state. The property comes from StateFlow
        // conflating equal values, which is why reach is a StateFlow of an enum
        // and not a callback — so this test guards the design, not just the code.
        val repo = SessionRepository()
        val seen = mutableListOf<Reach>()

        runBlocking {
            // UNDISPATCHED so the collector is already subscribed — and has
            // taken the initial value — before the first denial lands.
            val watching = launch(start = CoroutineStart.UNDISPATCHED) {
                repo.reach.collect { seen += it }
            }
            repeat(40) { repo.denied() }
            yield()
            watching.cancel()
        }

        // What the screen actually lives through: Loading, then NotPermitted,
        // and nothing after. Not forty notices, and no oscillation.
        assertEquals(listOf(Reach.Never, Reach.Denied), seen)
    }

    @Test
    fun `a denial from the last link does not survive into the next one`() {
        val repo = SessionRepository()
        repo.denied()

        repo.forget()

        // Anything else and a phone that was once refused would keep saying so
        // across a fresh link that had never been asked.
        assertEquals(Reach.Never, repo.reach.value)
    }

    @Test
    fun `a denial never empties a list we already hold`() {
        val repo = SessionRepository()
        repo.applySnapshot(SessionWire.parseList(listOf(summary("s1")).toJsonArray())!!)

        repo.denied()

        assertEquals(1, repo.sessions.value.size)
    }

    private fun summary(
        id: String,
        name: String = id,
        projectPath: String = "/repo/main",
        activityLevel: Any? = "idle",
    ): JSONObject = JSONObject(
        buildMap {
            put("id", id)
            put("name", name)
            put("projectPath", projectPath)
            put("cliTypeName", "Claude Code")
            if (activityLevel != null) put("activityLevel", activityLevel)
        },
    )

    private fun List<JSONObject>.toJsonArray(): JSONArray = JSONArray().also { array -> forEach(array::put) }
}

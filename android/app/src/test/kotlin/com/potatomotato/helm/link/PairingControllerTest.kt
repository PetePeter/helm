package com.potatomotato.helm.link

import com.potatomotato.helm.crypto.HelmInitiator
import com.potatomotato.helm.crypto.PipePair
import com.potatomotato.helm.crypto.ProtocolRange
import com.potatomotato.helm.crypto.ProtocolVersion
import com.potatomotato.helm.crypto.TestScheduler
import com.potatomotato.helm.data.PskStore
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The three decisions the controller owns: which PSK to offer, what the screen
 * shows, and whether anything is written to disk.
 *
 * Driven against a REAL [com.potatomotato.helm.crypto.SecureChannel] and a real
 * initiator, because "reject persists nothing" is only worth asserting if the
 * handshake that preceded it actually happened.
 */
class PairingControllerTest {
    private val store = InMemoryPskStore()
    private val inbound = mutableListOf<ByteArray>()

    private fun connect(
        controller: PairingController,
        range: ProtocolRange = ProtocolVersion.LOCAL_RANGE,
    ): HelmInitiator {
        val pipes = PipePair()
        controller.attach(pipes.phone)
        return HelmInitiator(pipes.helm, psk = store.load("desktop-test"), range = range)
            .also { it.start() }
    }

    private fun controller() = PairingController(
        store = store,
        machineId = "phone-test",
        scheduler = TestScheduler(),
        onInbound = { inbound.add(it) },
    )

    @Test
    fun `a first pairing asks the user to compare the desktop's own digits`() {
        val controller = controller()
        val desktop = connect(controller)

        val state = controller.state.value as PairingState.Comparing
        assertEquals("desktop-test", state.desktopId)
        assertEquals(desktop.sas, state.sas)
        assertTrue("nothing may be stored before the verdict", store.isEmpty)
    }

    @Test
    fun `confirming stores the PSK under the desktop's machine id`() {
        val controller = controller()
        connect(controller)

        controller.confirm(true)

        assertEquals(PairingState.Linked("desktop-test"), controller.state.value)
        assertEquals(setOf("desktop-test"), store.pairedMachineIds())
    }

    @Test
    fun `rejecting persists nothing and drops the link`() {
        val controller = controller()
        connect(controller)

        controller.confirm(false)

        assertTrue(store.isEmpty)
        assertEquals(PairingState.Idle, controller.state.value)
        assertFalse(controller.send("anything".toByteArray()))
    }

    @Test
    fun `a paired desktop reconnects straight to linked, with no second SAS prompt`() {
        val first = controller()
        connect(first)
        first.confirm(true)
        val storedPsk = store.load("desktop-test")

        val second = controller()
        val desktop = connect(second)

        assertEquals(PairingState.Linked("desktop-test"), second.state.value)
        assertTrue(second.send("hello again".toByteArray()))
        assertEquals("hello again", String(desktop.received.single()))
        assertArrayEquals("the PSK survives the reconnect", storedPsk, store.load("desktop-test"))
    }

    @Test
    fun `forgetting a desktop sends the next connection back to the SAS screen`() {
        val first = controller()
        connect(first)
        first.confirm(true)
        first.forget("desktop-test")

        assertTrue(store.isEmpty)
        val second = controller()
        connect(second)
        assertTrue(second.state.value is PairingState.Comparing)
    }

    @Test
    fun `messages only reach the app once the user has confirmed`() {
        val controller = controller()
        val desktop = connect(controller)

        desktop.send("early".toByteArray())
        assertTrue(inbound.isEmpty())

        controller.confirm(true)
        assertEquals("early", String(inbound.single()))
    }

    @Test
    fun `an incompatible desktop leaves an actionable message on screen`() {
        val controller = controller()
        connect(controller, range = ProtocolRange(4000, 4000))

        val failure = controller.state.value as PairingState.Failed
        assertTrue(failure.message, failure.message.contains("Update the phone app"))
        assertTrue(store.isEmpty)
    }
}

/** A [PskStore] with no device and no filesystem behind it. */
class InMemoryPskStore : PskStore {
    private val entries = mutableMapOf<String, ByteArray>()

    val isEmpty: Boolean get() = entries.isEmpty()

    override fun save(machineId: String, psk: ByteArray) {
        entries[machineId] = psk
    }

    override fun load(machineId: String): ByteArray? = entries[machineId]

    override fun forget(machineId: String) {
        entries.remove(machineId)
    }

    override fun pairedMachineIds(): Set<String> = entries.keys.toSet()
}

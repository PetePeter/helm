package com.potatomotato.helm.ble

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The seam SecureChannel talks to. The one behaviour worth a test is that the
 * inbound stream cannot drop a message published before anyone is collecting —
 * the HELLO race: the central subscribes on a binder thread while the pipe
 * above has not attached yet.
 */
class HelmLinkTest {
    @Test
    fun `a message published before any collector still arrives`() = runBlocking {
        val received = CompletableDeferred<ByteArray>()
        val hello = byteArrayOf(0x48, 0x45, 0x4C, 0x4C, 0x4F)

        HelmLink.publishInbound(hello)
        val collector = launch { HelmLink.inbound.collect { received.complete(it) } }

        assertArrayEquals(hello, withTimeout(5_000) { received.await() })
        collector.cancel()
    }

    @Test
    fun `detaching drops messages no collector ever took`() = runBlocking {
        HelmLink.publishInbound(byteArrayOf(0x01))
        HelmLink.publishInbound(byteArrayOf(0x02))

        HelmLink.detach()

        // Frames a dead link left unconsumed are garbage to the next one.
        assertNull(withTimeoutOrNull(1_000) { HelmLink.inbound.first() })
    }
}

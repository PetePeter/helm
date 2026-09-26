package com.potatomotato.helm.data

import com.potatomotato.helm.ble.RANK_BLE
import com.potatomotato.helm.ble.RANK_LAN
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The share-to-Helm refusal rules and state machine — pure, no link. */
class ShareToHelmTest {

    private val mb = 1024L * 1024

    @Test
    fun `the cap follows the transport holding the link`() {
        assertNull(shareRefusal(10 * mb, RANK_LAN, UploadSupport.Available))
        assertTrue(shareRefusal(10 * mb + 1, RANK_LAN, UploadSupport.Available)!!.startsWith("Too large for Wi-Fi"))
        assertNull(shareRefusal(2 * mb, RANK_BLE, UploadSupport.Available))
        assertEquals(
            "Too large for Bluetooth: 3.0 MB (limit 2.0 MB)",
            shareRefusal(3 * mb, RANK_BLE, UploadSupport.Available),
        )
    }

    @Test
    fun `no link, an old desktop, a revoked tool and an empty file are each refused up front`() {
        assertEquals("Not connected to Helm", shareRefusal(1, null, UploadSupport.Available))
        assertEquals("Not connected to Helm", shareRefusal(1, RANK_LAN, UploadSupport.Offline))
        assertTrue(shareRefusal(1, RANK_LAN, UploadSupport.DesktopTooOld)!!.contains("too old"))
        assertTrue(shareRefusal(1, RANK_LAN, UploadSupport.NotPermitted)!!.contains("not allowed"))
        assertEquals("The file is empty", shareRefusal(0, RANK_LAN, UploadSupport.Available))
    }

    @Test
    fun `a share runs picking to sending to done and names the session`() {
        val flow = ShareFlow()
        assertEquals(ShareState.Picking, flow.state.value)
        assertTrue(flow.start(100))
        assertFalse("one share at a time", flow.start(100))
        flow.progress(40)
        flow.progress(10)
        assertEquals("progress never runs backwards", ShareState.Sending(40, 100), flow.state.value)
        flow.done("persistence")
        assertEquals(ShareState.Done("Added to persistence draft"), flow.state.value)
        flow.failed("late timeout")
        assertEquals("a landed share is not un-landed by a late failure", ShareState.Done("Added to persistence draft"), flow.state.value)
    }

    @Test
    fun `a failure mid-send is terminal and a reset starts over`() {
        val flow = ShareFlow()
        flow.start(100)
        flow.failed("No link to Helm")
        assertEquals(ShareState.Failed("No link to Helm"), flow.state.value)
        flow.progress(50)
        assertEquals(ShareState.Failed("No link to Helm"), flow.state.value)
        flow.reset()
        assertEquals(ShareState.Picking, flow.state.value)
    }
}

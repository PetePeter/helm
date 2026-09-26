package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioRouteTest {
    @Test
    fun `bluetooth is the default whenever it is present`() {
        val available = setOf(AudioRoute.Earpiece, AudioRoute.Speaker, AudioRoute.Bluetooth)
        assertEquals(AudioRoute.Bluetooth, pickAudioRoute(current = null, available = available))
    }

    @Test
    fun `without bluetooth the call starts on the earpiece`() {
        val available = setOf(AudioRoute.Earpiece, AudioRoute.Speaker)
        assertEquals(AudioRoute.Earpiece, pickAudioRoute(current = null, available = available))
    }

    @Test
    fun `losing bluetooth falls back to the earpiece`() {
        val available = setOf(AudioRoute.Earpiece, AudioRoute.Speaker)
        assertEquals(AudioRoute.Earpiece, pickAudioRoute(current = AudioRoute.Bluetooth, available = available))
    }

    @Test
    fun `a route the user chose survives a device change that keeps it available`() {
        val available = setOf(AudioRoute.Earpiece, AudioRoute.Speaker, AudioRoute.Bluetooth)
        assertEquals(AudioRoute.Speaker, pickAudioRoute(current = AudioRoute.Speaker, available = available))
    }

    @Test
    fun `a tablet with no earpiece falls back to the speaker`() {
        assertEquals(AudioRoute.Speaker, pickAudioRoute(current = null, available = setOf(AudioRoute.Speaker)))
    }
}

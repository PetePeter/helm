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

    private val phone = setOf(AudioRoute.Earpiece, AudioRoute.Speaker)

    @Test
    fun `at the face the call is on the earpiece`() {
        assertEquals(AudioRoute.Earpiece, proximityRoute(near = true, available = phone))
    }

    @Test
    fun `away from the face the call is on the speaker`() {
        assertEquals(AudioRoute.Speaker, proximityRoute(near = false, available = phone))
    }

    @Test
    fun `a headset or the car is never switched by the sensor`() {
        assertEquals(null, proximityRoute(near = false, available = phone + AudioRoute.Bluetooth))
        assertEquals(null, proximityRoute(near = true, available = phone + AudioRoute.WiredHeadset))
    }

    @Test
    fun `a tablet with no earpiece stays on the speaker at the face`() {
        assertEquals(null, proximityRoute(near = true, available = setOf(AudioRoute.Speaker)))
    }
}

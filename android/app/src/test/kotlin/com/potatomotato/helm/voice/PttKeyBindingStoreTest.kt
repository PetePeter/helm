package com.potatomotato.helm.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class PttKeyBindingStoreTest {
    @Test
    fun `missing or invalid preference uses Alt Space`() {
        val storage = MemoryPttKeyBindingPreferences()
        val store = PttKeyBindingStore(storage)
        assertEquals(PttKeyBinding.AltSpace, store.read())

        storage.value = "invalid"
        assertEquals(PttKeyBinding.AltSpace, store.read())
    }

    @Test
    fun `each binding persists and is read back`() {
        val storage = MemoryPttKeyBindingPreferences()
        val store = PttKeyBindingStore(storage)

        PttKeyBinding.entries.forEach { binding ->
            store.write(binding)
            assertEquals(binding.name, storage.value)
            assertEquals(binding, store.read())
        }
    }

    private class MemoryPttKeyBindingPreferences : PttKeyBindingPreferences {
        var value: String? = null
        override fun read(): String? = value
        override fun write(value: String) { this.value = value }
    }
}

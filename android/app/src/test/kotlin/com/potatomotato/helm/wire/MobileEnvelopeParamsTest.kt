package com.potatomotato.helm.wire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Typed param values on the wire.
 *
 * The committed vectors only carry string params, so they cannot catch the bug
 * this guards: `session_read_terminal` declares `lines` as a NUMBER, and the
 * desktop dispatcher reads it with `typeof args.lines === 'number'`. A quoted
 * "200" is not refused — it is ignored, and the phone gets the default tail while
 * the UI says 200. These assert the JSON TEXT because the text is the contract.
 */
class MobileEnvelopeParamsTest {

    @Test
    fun `a numeric param is emitted unquoted so the desktop sees a number`() {
        val json = encode(linkedMapOf<String, Any>("sessionId" to "s1", "lines" to 200))

        assertEquals(
            """{"v":1,"t":"call","id":"p1","method":"session_read_terminal",""" +
                """"params":{"sessionId":"s1","lines":200}}""",
            json,
        )
    }

    @Test
    fun `a boolean param is emitted unquoted`() {
        val json = encode(linkedMapOf<String, Any>("stripBlankLines" to true, "keep" to false))

        assertEquals(""""params":{"stripBlankLines":true,"keep":false}}""", json.substringAfter(""","params"""").let { """"params"""" + it })
    }

    @Test
    fun `param order is the map's order, whatever the value types`() {
        val json = encode(linkedMapOf<String, Any>("z" to 1, "a" to "x", "m" to true))

        assertEquals("""{"z":1,"a":"x","m":true}""", json.substringAfter(""""params":""").dropLast(1))
    }

    @Test
    fun `a value the desktop has no type for is refused at the source`() {
        assertThrows(IllegalArgumentException::class.java) {
            encode(linkedMapOf<String, Any>("lines" to 200.5))
        }
    }

    private fun encode(params: Map<String, Any>): String =
        MobileEnvelope.encodeCall("p1", "session_read_terminal", params).toString(Charsets.UTF_8)
}

package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class JsonTest {
    @Test
    fun `eenvoudige waarden`() {
        assertEquals("tekst", Json.parse("\"tekst\""))
        assertEquals(42L, Json.parse("42"))
        assertEquals(-7L, Json.parse("-7"))
        assertEquals(1.5, Json.parse("1.5"))
        assertEquals(1200.0, Json.parse("1.2e3"))
        assertEquals(true, Json.parse("true"))
        assertEquals(false, Json.parse("false"))
        assertNull(Json.parse("null"))
        assertEquals(emptyMap<String, Any?>(), Json.parse("{}"))
        assertEquals(emptyList<Any?>(), Json.parse("[]"))
    }

    @Test
    fun `objecten en lijsten, ook genest en met witruimte`() {
        val value = Json.parse(" { \"a\" : [ 1 , 2 , { \"b\" : null } ] ,\n\t\"c\" : { \"d\" : \"e\" } } ")
        assertEquals(mapOf("a" to listOf(1L, 2L, mapOf("b" to null)), "c" to mapOf("d" to "e")), value)
    }

    @Test
    fun `tekst met escapes en bijzondere tekens`() {
        assertEquals("regel 1\nregel 2\ttab \"aanhaling\" \\ /", Json.parse("\"regel 1\\nregel 2\\ttab \\\"aanhaling\\\" \\\\ \\/\""))
        assertEquals("é", Json.parse("\"\\u00e9\""))
        assertEquals("é", Json.parse("\"\\u00E9\""))
        assertEquals("\uD83D\uDE00", Json.parse("\"\\ud83d\\ude00\"")) // emoji als twee \u-delen
        assertEquals("Café ☕ 😀", Json.parse("\"Café ☕ 😀\""))
    }

    @Test
    fun `grote getallen worden geen onzin`() {
        assertEquals(9007199254740993L, Json.parse("9007199254740993"))
        assertEquals(1.0e30, Json.parse("1000000000000000000000000000000"))
        assertEquals(1794577567000L, Json.parse("1794577567000"))
    }

    @Test
    fun `een dubbele sleutel - de laatste telt`() {
        assertEquals(mapOf("a" to 2L), Json.parse("{\"a\":1,\"a\":2}"))
    }

    @Test
    fun `ongeldige JSON geeft een nette fout`() {
        val bad = listOf(
            "", " ", "{", "}", "[", "]", "{\"a\"}", "{\"a\":}", "{\"a\":1,}", "[1,]", "[1 2]", "{a:1}", "{'a':1}", "\"open",
            "tru", "nul", "01x", "-", "1.", "1e", "+1", "\"\\x\"", "\"\\u12\"", "\"\\u12g4\"", "\"\\u+123\"", "{} extra", "[1][2]",
            "undefined", "NaN", "<html><body>502 Bad Gateway</body></html>",
        )
        for (text in bad) {
            try {
                Json.parse(text)
                fail("'$text' hoort een fout te geven")
            } catch (_: Json.ParseException) {
                // zoals verwacht
            }
        }
    }

    @Test
    fun `heel diep genest geeft een fout in plaats van een vastloper`() {
        val deep = "[".repeat(100_000) + "]".repeat(100_000)
        try {
            Json.parse(deep)
            fail("te diep genest hoort een fout te geven")
        } catch (_: Json.ParseException) {
            // zoals verwacht
        }
        assertNull(Json.parseObject("{\"a\":".repeat(100_000)))
        // 60 niveaus mag wel
        Json.parse("[".repeat(60) + "]".repeat(60))
    }

    @Test
    fun `parseObject geeft null bij alles wat geen object is`() {
        assertNull(Json.parseObject(null))
        assertNull(Json.parseObject(""))
        assertNull(Json.parseObject("[]"))
        assertNull(Json.parseObject("\"tekst\""))
        assertNull(Json.parseObject("42"))
        assertNull(Json.parseObject("null"))
        assertNull(Json.parseObject("geen json"))
        assertEquals(mapOf("ok" to true), Json.parseObject("{\"ok\":true}"))
        assertEquals(mapOf("ok" to true), Json.parseObject("\uFEFF{\"ok\":true}")) // met BOM ervoor
    }

    @Test
    fun `veilig uitlezen van velden`() {
        val o = Json.parseObject("""{"s":"x","n":30,"f":30.0,"h":30.5,"t":true,"z":0,"one":1,"nul":null,"o":{"k":1},"l":[1]}""")!!
        assertEquals("x", o.text("s"))
        assertNull(o.text("n"))
        assertNull(o.text("ontbreekt"))
        assertEquals(30L, o.whole("n"))
        assertEquals(30L, o.whole("f"))
        assertNull(o.whole("h"))
        assertNull(o.whole("s"))
        assertNull(o.whole("nul"))
        assertTrue(o.flag("t"))
        assertTrue(o.flag("one"))
        assertEquals(false, o.flag("z"))
        assertEquals(false, o.flag("s"))
        assertEquals(false, o.flag("ontbreekt"))
        assertEquals(true, o.flag("ontbreekt", default = true))
        assertEquals(mapOf("k" to 1L), o.obj("o"))
        assertNull(o.obj("l"))
        assertNull(o.obj("s"))
        assertEquals(listOf(1L), o.list("l"))
        assertNull(o.list("o"))
    }

    @Test
    fun `schrijven en weer teruglezen geeft hetzelfde`() {
        val value = mapOf(
            "tekst" to "regel 1\nregel 2 \"x\" \\ \u0001 é 😀",
            "getal" to 42L,
            "min" to -1L,
            "breuk" to 1.5,
            "waar" to true,
            "niets" to null,
            "lijst" to listOf(1L, "twee", listOf(3L), mapOf("vier" to 4L)),
            "leeg" to emptyMap<String, Any?>(),
        )
        assertEquals(value, Json.parse(Json.stringify(value)))
    }

    @Test
    fun `schrijven - de precieze vorm`() {
        assertEquals("""{"a":1,"b":[true,null,"x"]}""", Json.stringify(mapOf("a" to 1, "b" to listOf(true, null, "x"))))
        assertEquals("\"\\u0000\\n\\\"\"", Json.stringify("\u0000\n\""))
        assertEquals("3", Json.stringify(3.0))
        assertEquals("[]", Json.stringify(emptyList<Any>()))
    }
}

package io.github.wnijhof.tickory.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChooserTypesTest {
    @Test
    fun importeren_zipCsvEnJson_wordenTypen() {
        val types = ChooserTypes.mimeTypes(arrayOf(".zip", ".csv", ".json", "application/zip", "text/csv", "application/json"))!!
        assertTrue(types.contains("application/zip"))
        assertTrue(types.contains("application/x-zip-compressed"))
        assertTrue(types.contains("text/csv"))
        assertTrue(types.contains("text/comma-separated-values"))
        assertTrue(types.contains("application/json"))
        assertTrue("veel bestandsbeheerders geven een zip dit type", types.contains("application/octet-stream"))
        assertTrue("geen dubbele", types.size == types.toSet().size)
    }

    @Test
    fun eenTekstMetKommasEnHoofdletters_wordtOokGelezen() {
        val types = ChooserTypes.mimeTypes(arrayOf(" .ZIP , .Csv "))!!
        assertTrue(types.contains("application/zip"))
        assertTrue(types.contains("text/csv"))
    }

    @Test
    fun afbeeldingenAllesOfNiets_blijvenZoalsHetWas() {
        assertNull(ChooserTypes.mimeTypes(arrayOf()))
        assertNull(ChooserTypes.mimeTypes(arrayOf("")))
        assertNull(ChooserTypes.mimeTypes(null))
        assertNull(ChooserTypes.mimeTypes(arrayOf("image/*")))
        assertNull(ChooserTypes.mimeTypes(arrayOf(".csv", "*/*")))
        assertNull(ChooserTypes.mimeTypes(arrayOf(".pdf")), "een onbekende uitgang: dan alles, zoals de WebView het doet")
        assertNull(ChooserTypes.mimeTypes(arrayOf("geen type")))
    }

    @Test
    fun eenGewoonType_blijftStaan() {
        assertArrayEquals(arrayOf("application/pdf", "application/octet-stream"), ChooserTypes.mimeTypes(arrayOf("application/pdf")))
    }

    private fun assertNull(value: Any?, message: String) = org.junit.Assert.assertNull(message, value)
}

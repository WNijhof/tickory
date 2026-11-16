package io.github.wnijhof.tickory.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Wat de web-app via de WebView mag vragen: alleen de microfoon, alleen voor de eigen server. */
class WebPermissionsTest {
    private val app = "https://taken.example.nl"
    private val mic = arrayOf(WebPermissions.AUDIO_CAPTURE)

    @Test
    fun `de microfoon voor de eigen server mag naar de gebruiker`() {
        assertTrue(WebPermissions.allowMicrophone(mic, "https://taken.example.nl/", app))
        assertTrue(WebPermissions.allowMicrophone(mic, "https://taken.example.nl", app))
    }

    @Test
    fun `de camera, meer tegelijk, niets, of een andere pagina - geweigerd`() {
        assertFalse(WebPermissions.allowMicrophone(arrayOf("android.webkit.resource.VIDEO_CAPTURE"), "https://taken.example.nl/", app))
        assertFalse(WebPermissions.allowMicrophone(arrayOf(WebPermissions.AUDIO_CAPTURE, "android.webkit.resource.VIDEO_CAPTURE"), "https://taken.example.nl/", app))
        assertFalse(WebPermissions.allowMicrophone(emptyArray(), "https://taken.example.nl/", app))
        assertFalse(WebPermissions.allowMicrophone(null, "https://taken.example.nl/", app))
        assertFalse(WebPermissions.allowMicrophone(mic, "https://evil.example.com/", app))
        assertFalse("http is een andere oorsprong", WebPermissions.allowMicrophone(mic, "http://taken.example.nl/", app))
        assertFalse(WebPermissions.allowMicrophone(mic, null, app))
        assertFalse("nog geen server ingesteld", WebPermissions.allowMicrophone(mic, "https://taken.example.nl/", ""))
    }
}

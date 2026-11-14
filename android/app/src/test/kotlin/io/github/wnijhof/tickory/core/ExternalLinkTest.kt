package io.github.wnijhof.tickory.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalLinkTest {
    @Test
    fun webadressenMailTelefoonEnOtpauthGaanNaarEenAndereApp() {
        for (scheme in listOf("http", "https", "mailto", "tel", "otpauth", "HTTPS", "OtpAuth")) {
            assertTrue(scheme, ExternalLink.allowed(scheme))
        }
    }

    @Test
    fun alHetAndereNiet() {
        for (scheme in listOf(null, "", "intent", "file", "content", "javascript", "data", "blob", "market", "otpauth-migration", "tickory")) {
            assertFalse(scheme.toString(), ExternalLink.allowed(scheme))
        }
    }
}

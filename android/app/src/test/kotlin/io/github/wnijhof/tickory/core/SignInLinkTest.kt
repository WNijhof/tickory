package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInLinkTest {
    private val origin = "https://taken.voorbeeld.nl"
    private val state = "s".repeat(43)
    private val code = "tko_" + "a".repeat(43)

    @Test
    fun alleenHetStartadresOpDeEigenServerMagInDeBrowserOpen() {
        assertTrue(SignInLink.allowedStart("$origin/api/v1/auth/oidc/authorize?state=$state", origin))
        for (bad in listOf(
            null,
            "https://auth.voorbeeld.nl/authorize?state=$state", // de provider zelf: dat beslist de server, niet de pagina
            "https://taken.voorbeeld.nl.kwaad.org/api/v1/auth/oidc/authorize?state=$state",
            "http://taken.voorbeeld.nl/api/v1/auth/oidc/authorize?state=$state", // ander schema, dus een andere oorsprong
            "$origin/api/v1/auth/oidc/callback?state=$state",
            "$origin/api/v1/auth/oidc/authorize",
            "$origin/api/v1/auth/oidc/authorize?state=kort",
            "$origin/api/v1/auth/oidc/authorize?state=$state&redirect=https://kwaad.org",
            "$origin/api/v1/auth/oidc/authorize?state=$state#x",
            "$origin/api/v1/auth/oidc/../../x?state=$state",
            "https://iemand@taken.voorbeeld.nl/api/v1/auth/oidc/authorize?state=$state",
            "javascript:alert(1)",
            "$origin/api/v1/auth/oidc/authorize?state=${"s".repeat(600)}",
        )) {
            assertFalse(bad.toString(), SignInLink.allowedStart(bad, origin))
        }
        assertFalse("zonder ingestelde server niets", SignInLink.allowedStart("$origin/api/v1/auth/oidc/authorize?state=$state", ""))
    }

    @Test
    fun deTerugkeerlinkWordtEenVeiligFragment() {
        assertEquals("oidc=$code", SignInLink.fragmentFor("tickory://oidc?code=$code"))
        assertEquals("oidc=$code", SignInLink.fragmentFor("TICKORY://OIDC/?code=$code"))
        assertEquals("oidc-error=NO_ACCOUNT", SignInLink.fragmentFor("tickory://oidc?error=NO_ACCOUNT"))
        for (bad in listOf(
            null,
            "tickory://oidc",
            "tickory://oidc?code=kort",
            "tickory://oidc?code=$code&error=X",
            "tickory://oidc?code=$code#x",
            "tickory://oidc?code=';alert(1);'",
            "tickory://oidc?error=no_account",
            "tickory://oidc?state=$code",
            "tickory://oidc/anders?code=$code",
            "tickory://task/abc?code=$code",
            "tickory://iemand@oidc?code=$code",
            "tickory://oidc:80?code=$code",
            "https://oidc?code=$code",
            "andere-app://oidc?code=$code",
        )) {
            assertNull(bad.toString(), SignInLink.fragmentFor(bad))
        }
        for (fragment in listOf("oidc=$code", "oidc-error=EXPIRED")) {
            assertTrue(DeepLink.isSafe(fragment))
            assertTrue(SignInLink.isReturn(fragment))
        }
        assertFalse(SignInLink.isReturn("task=abc"))
        assertFalse(SignInLink.isReturn(null))
    }
}

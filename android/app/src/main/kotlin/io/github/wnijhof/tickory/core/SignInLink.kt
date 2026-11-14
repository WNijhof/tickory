package io.github.wnijhof.tickory.core

import java.net.URI
import java.net.URISyntaxException

/**
 * Inloggen via SSO (OpenID Connect) in de Android-app.
 *
 * De inlogpagina van de identiteitsprovider opent nooit in de WebView van de app: daar zou de app het wachtwoord kunnen meelezen,
 * en Google en andere providers weigeren een ingebouwde WebView. De web-app vraagt via de brug (`openSignIn`) om het begin van een
 * poging te openen in de browser van het toestel (een Custom Tab als de browser dat kent). Dat begin is altijd een adres op de eigen
 * server ([START_PATH] met alleen een `state`); de server stuurt de browser zelf door naar de provider. Zo hoeft de app niet te weten
 * welke provider het is, en kan een pagina de app nooit een willekeurig adres laten openen.
 *
 * Na het inloggen keert de browser terug via `tickory://oidc?code=…` (of `?error=…`). De code is eenmalig en een paar minuten
 * geldig, en werkt alleen samen met een geheim dat de web-app in de WebView bij het begin van de server kreeg: een andere app die
 * hetzelfde schema claimt en de link onderschept, heeft er niets aan (zoals PKCE bij RFC 8252). De app laadt de web-app daarna
 * opnieuw met `#oidc=<code>`; de web-app wisselt de code in.
 */
object SignInLink {
    const val SCHEME = "tickory"
    const val HOST = "oidc"
    const val START_PATH = "/api/v1/auth/oidc/authorize"

    /** De extra waarmee een browser een Custom Tab opent (androidx.browser zet hem ook; zonder bibliotheek, met dezelfde naam). */
    const val EXTRA_CUSTOM_TABS_SESSION = "android.support.customtabs.extra.SESSION"

    private val STATE = Regex("^state=[A-Za-z0-9_-]{20,100}$")
    private val CODE = Regex("^[A-Za-z0-9_-]{20,200}$")
    private val ERROR = Regex("^[A-Z_]{1,40}$")

    private fun parse(url: String): URI? = try {
        URI(url)
    } catch (e: URISyntaxException) {
        null
    }

    /** Mag de app dit adres in de browser openen als begin van een SSO-poging? Alleen het startadres op de ingestelde server. */
    fun allowedStart(url: String?, origin: String?): Boolean {
        if (url == null || url.length > 500 || !ServerAddress.sameOrigin(url, origin)) return false
        val uri = parse(url) ?: return false
        val query = uri.rawQuery ?: return false
        return uri.rawPath == START_PATH && STATE.matches(query) && uri.rawFragment == null && uri.rawUserInfo == null
    }

    /** Het fragment voor de web-app bij een terugkeer (`oidc=<code>` of `oidc-error=<CODE>`), of null als de link niet klopt. */
    fun fragmentFor(link: String?): String? {
        if (link == null || link.length > 500) return null
        val uri = parse(link) ?: return null
        if (uri.scheme?.lowercase() != SCHEME || uri.host?.lowercase() != HOST || uri.rawUserInfo != null || uri.port != -1) return null
        if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") return null
        if (uri.rawFragment != null) return null
        val query = uri.rawQuery ?: return null
        if (query.contains('&')) return null
        val key = query.substringBefore('=', "")
        val value = query.substringAfter('=', "")
        return when (key) {
            "code" -> value.takeIf(CODE::matches)?.let { "oidc=$it" }
            "error" -> value.takeIf(ERROR::matches)?.let { "oidc-error=$it" }
            else -> null
        }
    }

    /** Is dit fragment een terugkeer van SSO? Dan laadt de app de web-app opnieuw (die handelt de terugkeer af bij het starten). */
    fun isReturn(fragment: String?): Boolean = fragment != null && (fragment.startsWith("oidc=") || fragment.startsWith("oidc-error="))
}

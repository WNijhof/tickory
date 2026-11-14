package io.github.wnijhof.tickory.core

/**
 * Welke links de app aan een andere app geeft als de gebruiker erop tikt (alles buiten de eigen server laadt nooit in de app).
 * Webadressen, e-mail en telefoon, en `otpauth:` voor tweestapsverificatie: op een telefoon kun je de QR-code op je eigen
 * scherm niet scannen, dus de web-app biedt ook een link die de sleutel rechtstreeks aan een authenticator-app geeft
 * (Aegis, FreeOTP en dergelijke kennen dat adres). Al het andere (`intent:`, `file:`, `javascript:`, eigen schema's van
 * andere apps) wordt genegeerd.
 */
object ExternalLink {
    private val SCHEMES = setOf("http", "https", "mailto", "tel", "otpauth")

    fun allowed(scheme: String?): Boolean = scheme != null && scheme.lowercase() in SCHEMES
}

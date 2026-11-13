package io.github.wnijhof.tickory.core

import java.net.IDN

/**
 * Het adres van de server zoals de gebruiker het typt, teruggebracht tot de oorsprong: "https://host" of
 * "http://host:poort". Pad, zoekdeel en fragment vervallen. Zonder Android-klassen, zodat het op de pc te testen is.
 */
object ServerAddress {
    enum class Problem { EMPTY, SCHEME, CREDENTIALS, INVALID }

    sealed class Result {
        /**
         * @property origin wat we bewaren, bijvoorbeeld "http://192.168.1.10:8787"
         * @property host de naam of het IP-adres, kleine letters; IPv6 tussen blokhaken
         * @property schemeAssumed true als de gebruiker geen http:// of https:// typte en we https hebben aangenomen
         */
        data class Ok(val origin: String, val host: String, val https: Boolean, val schemeAssumed: Boolean) : Result()
        data class Invalid(val problem: Problem) : Result()
    }

    private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://")
    private val LABEL = Regex("^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$")
    private val IPV6 = Regex("^[0-9a-f:.]{2,45}$")
    private val PORT = Regex("^[0-9]{1,5}$")

    /** Leest wat de gebruiker typte. Zonder "http(s)://" ervoor nemen we https aan: veilig als uitgangspunt. */
    fun parse(input: String): Result = parseInternal(input, assumeHttps = true)

    /**
     * De oorsprong van een volledige URL (zoals de WebView die geeft), of null als het geen http(s)-adres is.
     * "about:blank", "data:", "blob:" en foutpagina's geven dus null.
     */
    fun originOf(url: String?): String? {
        if (url == null) return null
        return (parseInternal(url, assumeHttps = false) as? Result.Ok)?.origin
    }

    /** Hoort [url] bij de server met oorsprong [origin]? */
    fun sameOrigin(url: String?, origin: String?): Boolean {
        if (origin.isNullOrEmpty()) return false
        val actual = originOf(url) ?: return false
        return actual == origin
    }

    /**
     * Stuurt een http-adres door naar hetzelfde adres met https (veel voorkomend achter een reverse proxy), geef dan die
     * https-oorsprong terug. In alle andere gevallen null: een verwijzing naar een ander adres nemen we niet stilzwijgend over.
     */
    fun httpsUpgradeOf(origin: String, location: String?): String? {
        val from = parseInternal(origin, assumeHttps = false) as? Result.Ok ?: return null
        val to = parseInternal(location ?: return null, assumeHttps = false) as? Result.Ok ?: return null
        return if (!from.https && to.https && from.host == to.host) to.origin else null
    }

    private fun parseInternal(input: String, assumeHttps: Boolean): Result {
        val text = input.trim()
        if (text.isEmpty()) return Result.Invalid(Problem.EMPTY)

        val match = SCHEME.find(text)
        val scheme: String
        val rest: String
        val assumed: Boolean
        if (match != null) {
            scheme = match.groupValues[1].lowercase()
            rest = text.substring(match.value.length)
            assumed = false
        } else {
            // "ftp:host", "javascript:..." en dergelijke zijn geen serveradres; "nas:8787" (naam met poort) wel
            if (!assumeHttps || text.contains("://")) return Result.Invalid(Problem.SCHEME)
            scheme = "https"
            rest = text
            assumed = true
        }
        if (scheme != "http" && scheme != "https") return Result.Invalid(Problem.SCHEME)

        val authority = rest.takeWhile { it != '/' && it != '?' && it != '#' }
        if (authority.contains('@')) return Result.Invalid(Problem.CREDENTIALS)
        if (authority.isEmpty()) return Result.Invalid(Problem.INVALID)
        // Spaties, stuurtekens en backslashes horen niet in een hostnaam. Browsers lezen "\" als "/"; wij keuren het af.
        if (authority.any { it.isWhitespace() || it < ' ' || it == '\\' || it == '\u007f' }) return Result.Invalid(Problem.INVALID)

        val rawHost: String
        val rawPort: String?
        if (authority.startsWith("[")) {
            val end = authority.indexOf(']')
            if (end < 0) return Result.Invalid(Problem.INVALID)
            rawHost = authority.substring(0, end + 1)
            val tail = authority.substring(end + 1)
            rawPort = when {
                tail.isEmpty() -> null
                tail.startsWith(":") -> tail.substring(1)
                else -> return Result.Invalid(Problem.INVALID)
            }
        } else {
            val colon = authority.indexOf(':')
            if (colon >= 0) {
                rawHost = authority.substring(0, colon)
                rawPort = authority.substring(colon + 1)
            } else {
                rawHost = authority
                rawPort = null
            }
        }

        val host = normalizeHost(rawHost) ?: return Result.Invalid(Problem.INVALID)
        val https = scheme == "https"
        var port: Int? = null
        if (rawPort != null) {
            if (!PORT.matches(rawPort)) return Result.Invalid(Problem.INVALID)
            val number = rawPort.toInt()
            if (number < 1 || number > 65535) return Result.Invalid(Problem.INVALID)
            if (number != (if (https) 443 else 80)) port = number
        }
        val origin = "$scheme://$host" + (port?.let { ":$it" } ?: "")
        return Result.Ok(origin, host, https, assumed)
    }

    private fun normalizeHost(raw: String): String? {
        if (raw.startsWith("[")) {
            val inner = raw.substring(1, raw.length - 1).lowercase()
            return if (IPV6.matches(inner) && inner.contains(':')) "[$inner]" else null
        }
        if (raw.isEmpty() || raw.contains(':')) return null
        val ascii = try {
            IDN.toASCII(raw, IDN.ALLOW_UNASSIGNED).lowercase()
        } catch (_: IllegalArgumentException) {
            return null
        }
        val name = ascii.removeSuffix(".")
        if (name.isEmpty() || name.length > 253) return null
        if (!name.split('.').all { LABEL.matches(it) }) return null
        return name
    }
}

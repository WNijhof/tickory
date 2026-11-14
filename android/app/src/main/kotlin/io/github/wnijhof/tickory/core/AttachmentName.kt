package io.github.wnijhof.tickory.core

import java.text.Normalizer

/**
 * Namen en typen van bijlagen en gedeelde bestanden zoals de app ze lokaal gebruikt (de naam van een bestand in de cache, de
 * titel in "Opslaan als", het type voor "Openen met"). De naam van een bestand komt van de server of van een andere app en is dus
 * onbetrouwbaar: nooit een pad, geen stuurtekens, een beperkte lengte. Dit spiegelt `cleanFileName` uit `shared/attachments.js`.
 */
object AttachmentName {
    const val DEFAULT_NAME = "bijlage"
    const val MAX_LENGTH = 120
    const val OCTET_STREAM = "application/octet-stream"

    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb]")
    private val PATH_CHARS = Regex("[\\\\/:*?\"<>|]")
    private val SPACES = Regex("\\s+")
    private val EDGES = Regex("^[.\\s]+|[.\\s]+$")
    private val MIME = Regex("^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$")

    /** Een bestandsnaam die overal veilig is; nooit leeg, hooguit [MAX_LENGTH] tekens, de uitgang blijft behouden. */
    fun clean(raw: String?): String {
        var name = Normalizer.normalize(raw ?: "", Normalizer.Form.NFC)
        name = name.replace(Regex("[\t\n\r\u000c\u000b]+"), " ")
        name = CONTROL.replace(name, "")
        name = PATH_CHARS.replace(name, "_")
        name = SPACES.replace(name, " ").trim()
        name = EDGES.replace(name, "")
        if (name.isEmpty()) return DEFAULT_NAME
        val points = name.codePointCount(0, name.length)
        if (points > MAX_LENGTH) {
            val dot = name.lastIndexOf('.')
            val ext = if (dot > 0 && name.length - dot <= 17) name.substring(dot) else ""
            val base = if (ext.isEmpty()) name else name.substring(0, dot)
            val room = MAX_LENGTH - ext.codePointCount(0, ext.length)
            val cut = base.substring(0, base.offsetByCodePoints(0, minOf(room, base.codePointCount(0, base.length))))
            name = EDGES.replace(cut, "") + ext
            if (name.isEmpty()) return DEFAULT_NAME
        }
        return name
    }

    /** Het type zoals de server of een andere app het opgeeft, in kleine letters zonder parameters; onzin wordt een onbekend type. */
    fun mime(raw: String?): String {
        val base = raw?.substringBefore(';')?.trim()?.lowercase() ?: return OCTET_STREAM
        return if (MIME.matches(base)) base else OCTET_STREAM
    }

    /**
     * Het type waarmee een bestand aan een andere app wordt aangeboden ("Openen met"). Wat scripts kan bevatten (html, svg, xml,
     * javascript) gaat als gewone tekst: een andere app toont het dan als tekst en voert niets uit.
     */
    fun viewMime(raw: String?): String {
        val m = mime(raw)
        val risky = m == "text/html" || m == "application/xhtml+xml" || m == "image/svg+xml" || m == "text/xml" || m == "application/xml" ||
            m.endsWith("+xml") || m == "text/javascript" || m == "application/javascript"
        return if (risky) "text/plain" else m
    }
}

package io.github.wnijhof.tickory.core

import java.util.Base64

/**
 * "Delen naar Tickory": tekst of een link uit een andere app wordt een voorgevuld venster "Taak toevoegen".
 * De tekst gaat als `#share=<base64url van JSON>` naar de web-app. Base64url bevat alleen letters, cijfers, "-" en "_",
 * dus er kan niets uit het webadres of uit een stukje JavaScript breken, wat de ander ook deelt.
 * De web-app (`client/core/share.js`) maakt er een titel en een beschrijving van en laat de gebruiker het nog aanpassen.
 */
object ShareLink {
    const val MAX_SUBJECT = 300
    const val MAX_TEXT = 8_000

    /** Een bestand dat een andere app deelt, zoals de web-app het te zien krijgt (de inhoud haalt hij apart op, zie ShareStore). */
    data class SharedFile(val name: String, val mime: String, val size: Long)

    const val MAX_FILES = 20
    private val TOKEN = Regex("^[A-Za-z0-9_-]{16,64}$")

    /** Het fragment (zonder "#") voor een gedeelde tekst, of null als er niets te delen valt. */
    fun fragmentFor(subject: CharSequence?, text: CharSequence?): String? = fragmentFor(subject, text, emptyList(), null)

    /**
     * Zoals hierboven, met bestanden erbij: de web-app krijgt hun namen, typen en groottes en het `token` waarmee hij de inhoud
     * kan ophalen. Zonder geldig token of zonder bestanden gaat er niets over bestanden mee.
     */
    fun fragmentFor(subject: CharSequence?, text: CharSequence?, files: List<SharedFile>, token: String?): String? {
        val s = clean(subject, MAX_SUBJECT)
        val t = clean(text, MAX_TEXT)
        val list = if (token != null && TOKEN.matches(token)) files.take(MAX_FILES) else emptyList()
        if (s.isEmpty() && t.isEmpty() && list.isEmpty()) return null
        val q = '"'
        val json = StringBuilder("{${q}title${q}:${quote(s)},${q}text${q}:${quote(t)}")
        if (list.isNotEmpty()) {
            json.append(",${q}token${q}:${quote(token!!)},${q}files${q}:[")
            json.append(list.joinToString(",") { "{${q}name${q}:${quote(AttachmentName.clean(it.name))},${q}mime${q}:${quote(AttachmentName.mime(it.mime))},${q}size${q}:${it.size.coerceAtLeast(0)}}" })
            json.append("]")
        }
        json.append("}")
        return "share=" + Base64.getUrlEncoder().withoutPadding().encodeToString(json.toString().toByteArray(Charsets.UTF_8))
    }

    /** Afkappen zonder een teken in tweeën te breken (surrogaatpaar) en zonder lege randen. */
    internal fun clean(value: CharSequence?, max: Int): String {
        val v = value?.toString()?.trim() ?: return ""
        if (v.length <= max) return v
        var end = max
        if (Character.isHighSurrogate(v[end - 1])) end -= 1
        return v.substring(0, end).trimEnd()
    }

    private fun quote(value: String): String {
        val out = StringBuilder("\"")
        for (c in value) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append("\\u").append(String.format(java.util.Locale.ROOT, "%04x", c.code))
                else -> out.append(c)
            }
        }
        return out.append('"').toString()
    }
}

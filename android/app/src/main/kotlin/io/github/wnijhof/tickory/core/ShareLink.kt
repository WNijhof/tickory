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

    /** Het fragment (zonder "#") voor een gedeelde tekst, of null als er niets te delen valt. */
    fun fragmentFor(subject: CharSequence?, text: CharSequence?): String? {
        val s = clean(subject, MAX_SUBJECT)
        val t = clean(text, MAX_TEXT)
        if (s.isEmpty() && t.isEmpty()) return null
        val json = "{\"title\":${quote(s)},\"text\":${quote(t)}}"
        return "share=" + Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray(Charsets.UTF_8))
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

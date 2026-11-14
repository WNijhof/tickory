package io.github.wnijhof.tickory.core

/**
 * Spraakinvoer in de Android-app: het scherm van de spraakherkenner van Android geeft tekst terug, en die gaat als
 * gebeurtenis `tickory-voice` naar de web-app (`client/core/voice.js`). De tekst komt van buiten de app en gaat in een
 * stukje JavaScript, dus altijd als netjes ontsnapte tekenreeks, nooit los ingevoegd.
 */
object VoiceScript {
    const val EVENT = "tickory-voice"
    const val MAX_TEXT = 4_000

    private val KNOWN = setOf("no-speech", "unavailable", "cancelled")

    /** Het script voor een herkende tekst; leeg (of alleen witruimte) telt als "niets verstaan". */
    fun result(text: String?): String {
        val clean = text?.replace('\n', ' ')?.trim().orEmpty().take(MAX_TEXT)
        return if (clean.isEmpty()) error("no-speech") else dispatch("{text:${quote(clean)}}")
    }

    /** Het script voor een mislukte poging: `no-speech`, `unavailable` of `cancelled`. Onbekende codes worden `error`. */
    fun error(code: String): String {
        val safe = if (code in KNOWN) code else "error"
        return dispatch("{error:${quote(safe)}}")
    }

    private fun dispatch(detail: String) = "window.dispatchEvent(new CustomEvent(${quote(EVENT)},{detail:$detail}));"

    private fun quote(value: String): String {
        val out = StringBuilder("\"")
        for (c in value) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c == ' ' -> out.append("\\u2028")
                c == ' ' -> out.append("\\u2029")
                c == '<' -> out.append("\\u003c") // nooit </script> of <!-- in een tekenreeks laten staan
                c < ' ' -> out.append("\\u").append(String.format(java.util.Locale.ROOT, "%04x", c.code))
                else -> out.append(c)
            }
        }
        return out.append('"').toString()
    }
}

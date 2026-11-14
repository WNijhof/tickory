package io.github.wnijhof.tickory.core

/**
 * Kleine JSON-lezer en -schrijver zonder Android-klassen.
 *
 * Waarom niet org.json van Android: die klassen bestaan in unit-tests op de pc alleen als lege omhulsels, en de losse
 * bibliotheek met dezelfde naam gedraagt zich op details anders. Met deze eigen lezer testen we op de pc precies de
 * code die ook op de telefoon draait.
 *
 * Gelezen waarden: object -> Map<String, Any?>, lijst -> List<Any?>, tekst -> String, geheel getal -> Long,
 * ander getal -> Double, true/false -> Boolean, null -> null.
 */
object Json {
    class ParseException(message: String) : Exception(message)

    private const val MAX_DEPTH = 64

    @Throws(ParseException::class)
    fun parse(text: String): Any? {
        val parser = Parser(text)
        parser.skipWhitespace()
        val value = parser.readValue(0)
        parser.skipWhitespace()
        if (!parser.atEnd()) parser.fail("onverwachte tekens na het einde")
        return value
    }

    /** Het object in [text], of null als de tekst geen geldig JSON-object is. Gooit nooit. */
    fun parseObject(text: String?): Map<String, Any?>? {
        if (text == null) return null
        return try {
            asObject(parse(text))
        } catch (_: ParseException) {
            null
        } catch (_: StackOverflowError) {
            null
        }
    }

    @Suppress("UNCHECKED_CAST")
    fun asObject(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    fun asList(value: Any?): List<Any?>? = value as? List<Any?>

    fun stringify(value: Any?): String = StringBuilder().also { write(it, value) }.toString()

    private fun write(out: StringBuilder, value: Any?) {
        when (value) {
            null -> out.append("null")
            is String -> writeString(out, value)
            is Boolean -> out.append(if (value) "true" else "false")
            is Int, is Long, is Short, is Byte -> out.append(value.toString())
            is Number -> {
                val d = value.toDouble()
                require(!d.isNaN() && !d.isInfinite()) { "JSON kent geen NaN of oneindig" }
                out.append(if (d % 1.0 == 0.0 && kotlin.math.abs(d) < 1e15) d.toLong().toString() else d.toString())
            }
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) out.append(',')
                    first = false
                    writeString(out, k.toString())
                    out.append(':')
                    write(out, v)
                }
                out.append('}')
            }
            is Iterable<*> -> {
                out.append('[')
                var first = true
                for (v in value) {
                    if (!first) out.append(',')
                    first = false
                    write(out, v)
                }
                out.append(']')
            }
            else -> throw IllegalArgumentException("kan ${value::class.java.name} niet als JSON schrijven")
        }
    }

    private fun writeString(out: StringBuilder, s: String) {
        out.append('"')
        for (c in s) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '\u000C' -> out.append("\\f")
                // stuurtekens, en de twee Unicode-regelscheidingen (0x2028 en 0x2029) die in JavaScript-bronnen regels breken
                else -> if (c < ' ' || c.code == 0x2028 || c.code == 0x2029) {
                    out.append("\\u").append(c.code.toString(16).padStart(4, '0'))
                } else {
                    out.append(c)
                }
            }
        }
        out.append('"')
    }

    private class Parser(private val s: String) {
        // een byte-order-mark (teken 0xFEFF) aan het begin slaan we over
        private var i = if (s.isNotEmpty() && s[0].code == 0xFEFF) 1 else 0

        fun atEnd(): Boolean = i >= s.length

        fun fail(message: String): Nothing = throw ParseException("$message (positie $i)")

        fun skipWhitespace() {
            while (i < s.length) {
                val c = s[i]
                if (c == ' ' || c == '\n' || c == '\r' || c == '\t') i++ else break
            }
        }

        fun readValue(depth: Int): Any? {
            if (depth > MAX_DEPTH) fail("te diep genest")
            if (i >= s.length) fail("onverwacht einde")
            return when (val c = s[i]) {
                '{' -> readObject(depth)
                '[' -> readArray(depth)
                '"' -> readString()
                't' -> readLiteral("true", true)
                'f' -> readLiteral("false", false)
                'n' -> readLiteral("null", null)
                else -> if (c == '-' || c in '0'..'9') readNumber() else fail("onverwacht teken '$c'")
            }
        }

        private fun readLiteral(word: String, value: Any?): Any? {
            if (!s.startsWith(word, i)) fail("onbekende waarde")
            i += word.length
            return value
        }

        private fun readObject(depth: Int): Map<String, Any?> {
            val map = LinkedHashMap<String, Any?>()
            i++ // {
            skipWhitespace()
            if (i < s.length && s[i] == '}') {
                i++
                return map
            }
            while (true) {
                skipWhitespace()
                if (i >= s.length || s[i] != '"') fail("sleutel verwacht")
                val key = readString()
                skipWhitespace()
                if (i >= s.length || s[i] != ':') fail("':' verwacht")
                i++
                skipWhitespace()
                map[key] = readValue(depth + 1)
                skipWhitespace()
                if (i >= s.length) fail("onverwacht einde in object")
                when (s[i]) {
                    ',' -> i++
                    '}' -> {
                        i++
                        return map
                    }
                    else -> fail("',' of '}' verwacht")
                }
            }
        }

        private fun readArray(depth: Int): List<Any?> {
            val list = ArrayList<Any?>()
            i++ // [
            skipWhitespace()
            if (i < s.length && s[i] == ']') {
                i++
                return list
            }
            while (true) {
                skipWhitespace()
                list.add(readValue(depth + 1))
                skipWhitespace()
                if (i >= s.length) fail("onverwacht einde in lijst")
                when (s[i]) {
                    ',' -> i++
                    ']' -> {
                        i++
                        return list
                    }
                    else -> fail("',' of ']' verwacht")
                }
            }
        }

        private fun readString(): String {
            i++ // openingsaanhalingsteken
            val out = StringBuilder()
            while (true) {
                if (i >= s.length) fail("tekst niet afgesloten")
                val c = s[i++]
                when (c) {
                    '"' -> return out.toString()
                    '\\' -> {
                        if (i >= s.length) fail("onvolledige escape")
                        when (val e = s[i++]) {
                            '"' -> out.append('"')
                            '\\' -> out.append('\\')
                            '/' -> out.append('/')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail("onvolledige \\u-escape")
                                var code = 0
                                repeat(4) {
                                    val digit = Character.digit(s[i++], 16)
                                    if (digit < 0) fail("ongeldige \\u-escape")
                                    code = code * 16 + digit
                                }
                                out.append(code.toChar())
                            }
                            else -> fail("onbekende escape '\\$e'")
                        }
                    }
                    else -> out.append(c)
                }
            }
        }

        private fun readNumber(): Any {
            val start = i
            if (s[i] == '-') i++
            val digitsStart = i
            while (i < s.length && s[i] in '0'..'9') i++
            if (i == digitsStart) fail("cijfer verwacht")
            var integral = true
            if (i < s.length && s[i] == '.') {
                integral = false
                i++
                val fracStart = i
                while (i < s.length && s[i] in '0'..'9') i++
                if (i == fracStart) fail("cijfer verwacht na de punt")
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                integral = false
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                val expStart = i
                while (i < s.length && s[i] in '0'..'9') i++
                if (i == expStart) fail("cijfer verwacht in de exponent")
            }
            val text = s.substring(start, i)
            if (integral) text.toLongOrNull()?.let { return it }
            return text.toDoubleOrNull() ?: fail("ongeldig getal")
        }
    }
}

// ---------- veilig uitlezen: een ontbrekend veld of een veld van het verkeerde soort geeft null ----------

fun Map<String, Any?>.text(key: String): String? = this[key] as? String

fun Map<String, Any?>.obj(key: String): Map<String, Any?>? = Json.asObject(this[key])

fun Map<String, Any?>.list(key: String): List<Any?>? = Json.asList(this[key])

/** Een geheel getal; ook 30.0 telt, 30.5 niet. */
fun Map<String, Any?>.whole(key: String): Long? = when (val v = this[key]) {
    is Long -> v
    is Double -> if (v % 1.0 == 0.0 && kotlin.math.abs(v) < 9.0e15) v.toLong() else null
    else -> null
}

/** Een getal met of zonder komma (JSON kent geen onderscheid); geen tekst, geen NaN. */
fun Map<String, Any?>.real(key: String): Double? = when (val v = this[key]) {
    is Long -> v.toDouble()
    is Double -> v.takeIf { it.isFinite() }
    else -> null
}

/** true/false; de server stuurt echte booleans, maar 1 en 0 lezen we ook. Al het andere geeft [default]. */
fun Map<String, Any?>.flag(key: String, default: Boolean = false): Boolean = when (val v = this[key]) {
    is Boolean -> v
    is Long -> v != 0L
    is Double -> v != 0.0
    else -> default
}

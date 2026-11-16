package io.github.wnijhof.tickory.core

import java.text.Normalizer
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

/**
 * Tekst vergelijkbaar maken op dezelfde manier als de web-app: [nameKey] zoals `nameKey` in shared/text.js (voor namen) en
 * [fold] zoals `foldText` in client/core/fold.js (voor zoeken: zonder hoofdletters, accenten en dubbele witruimte).
 * Witruimte is wat `\s` in JavaScript is, niet alleen de ASCII-tekens die `\s` in Java kent.
 */
object FilterText {
    /** Eén teken witruimte zoals `\s` in JavaScript. */
    fun isSpace(c: Char): Boolean = when (c) {
        '\t', '\n', '\u000B', '\u000C', '\r', ' ', '\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF' -> true
        else -> c in '\u2000'..'\u200A'
    }

    /** `\s` in JavaScript, als tekenklasse voor een Kotlin-patroon. */
    const val SPACE_CLASS = "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]"

    fun nfc(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFC)

    /** `String.prototype.trim()`. */
    fun trim(s: String): String {
        var a = 0
        var b = s.length
        while (a < b && isSpace(s[a])) a++
        while (b > a && isSpace(s[b - 1])) b--
        return s.substring(a, b)
    }

    /** `s.replace(/\s+/g, ' ')`. */
    fun collapse(s: String): String {
        val out = StringBuilder(s.length)
        var inSpace = false
        for (c in s) {
            if (isSpace(c)) {
                if (!inSpace) out.append(' ')
                inSpace = true
            } else {
                out.append(c)
                inSpace = false
            }
        }
        return out.toString()
    }

    /** De sleutel waarmee namen vergeleken worden (shared/text.js). */
    fun nameKey(s: String): String = collapse(trim(nfc(s))).lowercase(Locale.ROOT)

    private val MARK = Regex("\\p{M}")

    /** De gevouwen tekst (client/core/fold.js): "Café", "CAFÉ" en "Cafe" met een los accent worden "cafe". */
    fun fold(source: String): String {
        if (source.all { it.code < 0x80 }) return collapse(source).lowercase(Locale.ROOT)
        val out = StringBuilder(source.length)
        var i = 0
        while (i < source.length) {
            val cp = source.codePointAt(i)
            val count = Character.charCount(cp)
            if (count == 1 && isSpace(source[i])) {
                i++
                while (i < source.length && isSpace(source[i])) i++
                out.append(' ')
                continue
            }
            val ch = source.substring(i, i + count)
            i += count
            out.append(MARK.replace(Normalizer.normalize(ch, Normalizer.Form.NFKD), "").lowercase(Locale.ROOT))
        }
        return out.toString()
    }

    /** Unieke gevouwen woorden, in de volgorde waarin ze staan (foldWords). */
    fun foldWords(text: String, maxWords: Int): List<String> =
        fold(text).split(' ').filter { it.isNotEmpty() }.distinct().take(maxWords)
}

/**
 * De filtertaal van de web-app (client/core/filter.js), voor opgeslagen filters in een widget. Dezelfde termen in het Nederlands
 * en het Engels, dezelfde voorrang (`!` voor `&` voor `|`, haakjes voor alles, komma's voor aparte lijsten) en dezelfde fouten met
 * dezelfde plek. Wat de widget niet kent: datums in gewone taal ("donderdag", "eind januari"). Die leest de web-app met een
 * meegebundelde herkenner; hier zijn ze een fout, net als in de web-app met `naturalDates: false`. De testgevallen in
 * src/test/resources/filter-vectors.json komen uit de web-app (scripts/filter-vectors.ts) en houden beide gelijk.
 *
 * Alleen open taken: de widgets bewaren geen afgevinkte taken, dus "afgevinkt" levert hier niets op.
 */
object FilterLang {
    const val MAX_QUERY_LENGTH = 2000
    private const val MAX_DEPTH = 40
    private const val MAX_DAYS = 36_500

    /** Een fout zoals de web-app hem geeft: `code` (zie filter.js), de plek in de getypte tekst en de lengte (minstens 1). */
    data class Error(val code: String, val position: Int, val length: Int)

    data class Group(val name: String, val tasks: List<WidgetTask>)

    sealed class Outcome {
        /** @property tasks bij één lijst die lijst, bij meer lijsten alle taken uit alle lijsten (elke taak één keer) */
        data class Ok(val tasks: List<WidgetTask>, val groups: List<Group>, val includesCompleted: Boolean) : Outcome()
        data class Failed(val error: Error) : Outcome()
    }

    private class Fail(val error: Error) : RuntimeException(error.code, null, false, false)

    private fun fail(code: String, position: Int, length: Int): Nothing = throw Fail(Error(code, position, maxOf(1, length)))
    private fun failAt(code: String, tok: Tok): Nothing = fail(code, tok.start, tok.end - tok.start)

    // ---------- lezen: van tekst naar tokens ----------

    private data class Tok(val type: String, val value: String, val start: Int, val end: Int)

    private const val SP = FilterText.SPACE_CLASS
    private val RESERVED_PREFIX = Regex("(?iu)^(?:zoek|zoeken|search|voor|vóór|before|na|after|toegewezen aan|assigned to)$")
    private val SEARCH_PREFIX = Regex("(?iu)^(?:zoek|zoeken|search)$SP*:$")

    private fun isOperator(c: Char) = c == '&' || c == '|' || c == '(' || c == ')'

    private fun lex(q: String): List<Tok> {
        val tokens = ArrayList<Tok>()
        val n = q.length
        var i = 0
        var groupHasToken = false
        outer@ while (i < n) {
            val c = q[i]
            if (FilterText.isSpace(c)) {
                i++
                continue
            }
            if (isOperator(c) || c == '!') {
                tokens.add(Tok(c.toString(), "", i, i + 1))
                groupHasToken = true
                i++
                continue
            }
            if (c == ',') {
                tokens.add(Tok(",", "", i, i + 1))
                groupHasToken = false
                i++
                continue
            }
            val start = i
            val value = StringBuilder()
            var last = i
            var search = false // in een zoektekst is `!` gewoon een teken
            while (i < n) {
                val d = q[i]
                if (d == '\\' && i + 1 < n) {
                    value.append(q[i + 1])
                    i += 2
                    last = i
                    continue
                }
                if (d == '"') {
                    val j = q.indexOf('"', i + 1)
                    if (j < 0) fail("unclosed_quote", i, 1)
                    value.append(q, i + 1, j)
                    i = j + 1
                    last = i
                    continue
                }
                if (isOperator(d) || d == ',') break
                if (d == '!' && !search) break
                if (d == ':' && !groupHasToken) {
                    // "Naam: filter" aan het begin van een lijst geeft die lijst een naam (behalve bij zoek:, vóór:, na: enz.)
                    val name = FilterText.trim(FilterText.collapse(value.toString()))
                    if (name.isNotEmpty() && !RESERVED_PREFIX.matches(name) && name[0] != '#' && name[0] != '@' && name[0] != '/') {
                        tokens.add(Tok("name", FilterText.nfc(name), i, i + 1))
                        groupHasToken = true
                        i++
                        continue@outer
                    }
                }
                value.append(d)
                if (!FilterText.isSpace(d)) last = i + 1
                i++
                if (d == ':' && SEARCH_PREFIX.matches(FilterText.trim(value.toString()))) search = true
            }
            tokens.add(Tok("term", FilterText.nfc(FilterText.trim(FilterText.collapse(value.toString()))), start, maxOf(last, start + 1)))
            groupHasToken = true
        }
        return tokens
    }

    // ---------- datums (als tekst 'YYYY-MM-DD', zoals in de web-app) ----------

    private val MONTHS = mapOf(
        "januari" to 1, "january" to 1, "jan" to 1, "februari" to 2, "february" to 2, "feb" to 2, "maart" to 3, "march" to 3, "mrt" to 3,
        "mar" to 3, "april" to 4, "apr" to 4, "mei" to 5, "may" to 5, "juni" to 6, "june" to 6, "jun" to 6, "juli" to 7, "july" to 7,
        "jul" to 7, "augustus" to 8, "august" to 8, "aug" to 8, "september" to 9, "sept" to 9, "sep" to 9, "oktober" to 10,
        "october" to 10, "okt" to 10, "oct" to 10, "november" to 11, "nov" to 11, "december" to 12, "dec" to 12,
    )

    private fun addDays(day: String, n: Long): String = LocalDate.parse(day).plusDays(n).toString()
    private fun mondayOf(day: String): String = LocalDate.parse(day).let { it.minusDays((it.dayOfWeek.value - DayOfWeek.MONDAY.value).toLong()) }.toString()
    private fun pad(n: Int, width: Int) = n.toString().padStart(width, '0')

    /**
     * isValidDate uit shared/recurrence.js voor een dag: bestaat hij? JavaScript leest jaren 0 t/m 99 als 1900 t/m 1999, dus
     * die gelden daar niet; hier dus ook niet.
     */
    private fun validDay(y: Int, m: Int, d: Int): Boolean {
        if (y < 100) return false
        return try {
            LocalDate.of(y, m, d)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun resolveDay(d: Int, m: Int, y: Int?, today: String): String? {
        val year = y ?: today.substring(0, 4).toInt()
        val text = "${pad(year, 4)}-${pad(m, 2)}-${pad(d, 2)}"
        // de tekst moet ook de vorm YYYY-MM-DD hebben (een dag of maand van drie cijfers komt in de patronen niet voor)
        return if (text.length == 10 && validDay(year, m, d)) text else null
    }

    private val ISO = Regex("^(\\d{4})-(\\d{1,2})-(\\d{1,2})$")
    private val NUMERIC = Regex("^(\\d{1,2})[-/.](\\d{1,2})(?:[-/.](\\d{4}))?$")
    private val DAY_MONTH = Regex("^(\\d{1,2}) ?-?([a-z]+)\\.?(?: (\\d{4}))?$")
    private val MONTH_DAY = Regex("^([a-z]+)\\.? (\\d{1,2})(?: (\\d{4}))?$")

    /**
     * Een datum in een vaste vorm als dag (zie parseDay in filter.js). Null als de tekst geen datum lijkt; een fout als het er een
     * lijkt die niet bestaat (31-02). Datums in gewone taal kent de widget niet: die zijn null.
     */
    private fun parseDay(text: String, env: Env, tok: Tok): String? {
        val key = FilterText.fold(text)
        val today = env.today
        when (key) {
            "vandaag", "today" -> return today
            "morgen", "tomorrow" -> return addDays(today, 1)
            "gisteren", "yesterday" -> return addDays(today, -1)
            "overmorgen" -> return addDays(today, 2)
        }
        var parts: Triple<Int, Int, Int?>? = null
        ISO.find(key)?.let { m -> parts = Triple(m.groupValues[3].toInt(), m.groupValues[2].toInt(), m.groupValues[1].toInt()) }
        if (parts == null) NUMERIC.find(key)?.let { m -> parts = Triple(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groups[3]?.value?.toInt()) }
        if (parts == null) DAY_MONTH.find(key)?.let { m ->
            MONTHS[m.groupValues[2]]?.let { month -> parts = Triple(m.groupValues[1].toInt(), month, m.groups[3]?.value?.toInt()) }
        }
        if (parts == null) MONTH_DAY.find(key)?.let { m ->
            MONTHS[m.groupValues[1]]?.let { month -> parts = Triple(m.groupValues[2].toInt(), month, m.groups[3]?.value?.toInt()) }
        }
        val p = parts ?: return null
        return resolveDay(p.first, p.second, p.third, today) ?: failAt("invalid_date", tok)
    }

    // ---------- termen ----------

    private fun interface Match {
        fun test(t: WidgetTask): Boolean
    }

    private fun dayOf(t: WidgetTask): String? = t.due?.take(10)
    private fun onDay(d: String) = Match { dayOf(it) == d }
    private fun between(lo: String, hi: String) = Match { t -> dayOf(t)?.let { it >= lo && it <= hi } == true }

    private class Env(
        val query: String,
        val today: String,
        val nowStr: String,
        val userId: String?,
        val snapshot: WidgetSnapshot,
    ) {
        var completed = false

        fun subprojectIds(roots: Set<String>): List<String> {
            val children = HashMap<String, MutableList<String>>()
            for (p in snapshot.projects) {
                val parent = p.parentId ?: continue
                children.getOrPut(parent) { ArrayList() }.add(p.id)
            }
            val seen = HashSet(roots)
            val todo = ArrayList(roots)
            val out = ArrayList<String>()
            while (todo.isNotEmpty()) {
                for (kid in children[todo.removeAt(todo.size - 1)] ?: emptyList()) {
                    if (!seen.add(kid)) continue
                    out.add(kid)
                    todo.add(kid)
                }
            }
            return out
        }
    }

    /** dueStatus uit client/core/format.js: is de datum (met een tijdstip: het tijdstip) voorbij? */
    private fun overdue(due: String, today: String, now: String): Boolean {
        val day = due.take(10)
        if (day < today) return true
        if (day > today) return false
        return due.length > 10 && due.take(16) < now
    }

    private val KEYWORDS: Map<String, (Env) -> Match> = buildMap {
        fun keyword(names: List<String>, build: (Env) -> Match) { for (n in names) put(n, build) }
        keyword(listOf("vandaag", "today")) { env -> onDay(env.today) }
        keyword(listOf("morgen", "tomorrow")) { env -> onDay(addDays(env.today, 1)) }
        keyword(listOf("gisteren", "yesterday")) { env -> onDay(addDays(env.today, -1)) }
        keyword(listOf("te laat", "overdue")) { env -> Match { t -> t.due != null && overdue(t.due, env.today, env.nowStr) } }
        keyword(listOf("geen datum", "zonder datum", "no date", "no due date")) { Match { dayOf(it) == null } }
        keyword(listOf("heeft tijd", "has time")) { Match { t -> t.due != null && t.due.length > 10 } }
        keyword(listOf("geen tijd", "no time")) { Match { t -> t.due != null && t.due.length <= 10 } }
        keyword(listOf("deze week", "this week")) { env -> mondayOf(env.today).let { between(it, addDays(it, 6)) } }
        keyword(listOf("volgende week", "next week")) { env -> mondayOf(env.today).let { between(addDays(it, 7), addDays(it, 13)) } }
        keyword(listOf("vorige week", "last week")) { env -> mondayOf(env.today).let { between(addDays(it, -7), addDays(it, -1)) } }
        keyword(listOf("terugkerend", "herhalend", "recurring")) { Match { it.recurring } }
        keyword(listOf("deadline", "heeft deadline", "has deadline")) { Match { it.deadline } }
        keyword(listOf("geen deadline", "no deadline")) { Match { !it.deadline } }
        keyword(listOf("subtaak", "subtask")) { Match { it.parentId != null } }
        keyword(listOf("zonder label", "zonder labels", "geen label", "geen labels", "no label", "no labels")) { Match { it.labelIds.isEmpty() } }
        keyword(listOf("niet toegewezen", "unassigned")) { Match { it.assigneeId == null } }
        keyword(listOf("toegewezen", "assigned")) { Match { it.assigneeId != null } }
        keyword(listOf("heeft herinnering", "has reminder")) { Match { it.hasReminder } }
        keyword(listOf("geen herinnering", "no reminder")) { Match { !it.hasReminder } }
        keyword(listOf("afgevinkt", "completed")) { env ->
            env.completed = true
            Match { false } // alleen open taken op het toestel
        }
        keyword(listOf("alles", "all", "view all")) { Match { true } }
    }

    private fun <T> findByName(rows: List<T>, name: String, nameOf: (T) -> String): List<T> {
        val key = FilterText.nameKey(name)
        val exact = rows.filter { FilterText.nameKey(nameOf(it)) == key }
        if (exact.isNotEmpty()) return exact
        val folded = FilterText.fold(name)
        return rows.filter { FilterText.fold(nameOf(it)) == folded }
    }

    private fun findUsers(users: List<WidgetUser>, name: String): List<WidgetUser> {
        val key = FilterText.fold(name)
        return users.filter { u ->
            val full = FilterText.fold(u.name)
            full == key || FilterText.fold(u.username) == key || full.split(' ')[0] == key
        }
    }

    private val PRIORITY = Regex("^p([1-4])$")
    private val SEARCH = Regex("(?ius)^(?:zoek|zoeken|search)$SP*:$SP*(.*)$")
    private val BEFORE_AFTER = Regex("(?ius)^(voor|vóór|before|na|after)$SP*:$SP*(.*)$")
    private val BEFORE = Regex("(?iu)^(?:voor|vóór|before)$")
    private val ASSIGNED = Regex("(?iu)^(?:toegewezen aan|assigned to)(?:$SP*:$SP*|$SP+)(.+)$")
    private val NEXT_DAYS = Regex("^(?:(?:volgende|next) )?(\\d+) (?:dagen|dag|days|day)$")
    private val LAST_DAYS = Regex("^-(\\d+) (?:dagen|dag|days|day)$")

    private fun compileTerm(tok: Tok, env: Env, hint: Boolean = true): Match {
        val raw = tok.value
        if (raw.isEmpty()) failAt("empty_term", tok)
        val key = FilterText.fold(raw)
        KEYWORDS[key]?.let { return it(env) }

        // #project, ##project, /sectie, @label
        val prefix = when {
            raw.startsWith("##") -> "##"
            raw[0] == '#' || raw[0] == '/' || raw[0] == '@' -> raw.substring(0, 1)
            else -> null
        }
        if (prefix != null) {
            val name = FilterText.trim(raw.substring(prefix.length))
            if (name.isEmpty()) failAt("empty_name", tok)
            if (prefix == "@") {
                val ids = findByName(env.snapshot.labels, name) { it.name }.mapTo(HashSet()) { it.id }
                if (ids.isEmpty()) failAt("unknown_label", tok)
                return Match { t -> t.labelIds.any { it in ids } }
            }
            if (prefix == "/") {
                val ids = findByName(env.snapshot.sections, name) { it.name }.mapTo(HashSet()) { it.id }
                if (ids.isEmpty()) failAt("unknown_section", tok)
                return Match { t -> t.sectionId != null && t.sectionId in ids }
            }
            val found = findByName(env.snapshot.projects, name) { it.name }
            if (found.isEmpty()) failAt("unknown_project", tok)
            val ids = found.mapTo(LinkedHashSet()) { it.id }
            if (prefix == "##") ids.addAll(env.subprojectIds(ids))
            return Match { it.projectId in ids }
        }

        PRIORITY.find(key)?.let { m ->
            val level = m.groupValues[1].toInt()
            return Match { it.priority == level }
        }

        // zoek: tekst
        SEARCH.find(raw)?.let { m ->
            val words = FilterText.foldWords(m.groupValues[1], 20)
            if (words.isEmpty()) failAt("empty_term", tok)
            return Match { t -> words.all { t.search.contains(it) } }
        }

        // vóór: datum, na: datum
        BEFORE_AFTER.find(raw)?.let { m ->
            val text = m.groupValues[2]
            val day = if (text.isNotEmpty()) parseDay(text, env, tok) else null
            if (day == null) failAt("invalid_date", tok)
            return if (BEFORE.matches(m.groupValues[1])) {
                Match { t -> dayOf(t)?.let { it < day } == true }
            } else {
                Match { t -> dayOf(t)?.let { it > day } == true }
            }
        }

        // toegewezen aan mij / anderen / naam
        ASSIGNED.find(raw)?.let { m ->
            val who = FilterText.trim(m.groupValues[1])
            val whoKey = FilterText.fold(who)
            val me = env.userId
            if (whoKey == "mij" || whoKey == "me") {
                if (me == null) failAt("no_user", tok)
                return Match { it.assigneeId == me }
            }
            if (whoKey == "anderen" || whoKey == "others") {
                if (me == null) failAt("no_user", tok)
                return Match { it.assigneeId != null && it.assigneeId != me }
            }
            val ids = findUsers(env.snapshot.users, who).mapTo(HashSet()) { it.id }
            if (ids.isEmpty()) failAt("unknown_user", tok)
            return Match { it.assigneeId != null && it.assigneeId in ids }
        }

        // 7 dagen, volgende 7 dagen, -7 dagen
        NEXT_DAYS.find(key)?.let { m ->
            val digits = m.groupValues[1]
            if (digits.length > 6 || digits.toInt() > MAX_DAYS) failAt("bad_number", tok)
            return between(env.today, addDays(env.today, digits.toLong()))
        }
        LAST_DAYS.find(key)?.let { m ->
            val digits = m.groupValues[1]
            if (digits.length > 6 || digits.toInt() > MAX_DAYS) failAt("bad_number", tok)
            return between(addDays(env.today, -digits.toLong()), env.today)
        }

        // een datum: precies die dag
        parseDay(raw, env, tok)?.let { return onDay(it) }
        if (hint) forgottenOperator(raw, tok, env)
        failAt("unknown_term", tok)
    }

    private val NON_SPACE = Regex("[^${SP.removePrefix("[").removeSuffix("]")}]+")

    /** "vandaag morgen" (twee termen zonder & of |): wijs de plek aan waar de operator ontbreekt. */
    private fun forgottenOperator(raw: String, tok: Tok, env: Env) {
        val words = raw.split(' ')
        if (words.size < 2 || words.size > 8) return
        val source = env.query.substring(tok.start, tok.end)
        for (k in 1 until words.size) {
            try {
                compileTerm(tok.copy(value = words.subList(0, k).joinToString(" ")), env, hint = false)
            } catch (_: Fail) {
                continue
            }
            val plain = !source.contains('"') && !source.contains('\\')
            val at = if (plain) NON_SPACE.findAll(source).elementAtOrNull(k)?.range?.first else null
            val start = if (at == null) tok.start else tok.start + at
            fail("expected_operator", start, if (at == null) tok.end - tok.start else tok.end - start)
        }
    }

    // ---------- ontleden ----------

    private class Parsed(val name: String, val match: Match)

    private fun parse(q: String, tokens: List<Tok>, env: Env): List<Parsed> {
        var pos = 0
        fun peek(): Tok? = tokens.getOrNull(pos)

        lateinit var parseOr: (Int, Tok?) -> Match

        fun parsePrimary(depth: Int, after: Tok?): Match {
            val tok = peek()
            if (tok?.type == "(") {
                if (depth >= MAX_DEPTH) failAt("too_deep", tok)
                pos++
                val inner = parseOr(depth + 1, tok)
                val close = peek() ?: failAt("unclosed_paren", tok)
                if (close.type == ")") {
                    pos++
                    return inner
                }
                if (close.type == ",") failAt("comma_in_parens", close)
                failAt("expected_operator", close)
            }
            if (tok?.type == "term") {
                pos++
                return compileTerm(tok, env)
            }
            fail("empty_term", tok?.start ?: (after?.start ?: 0), if (tok != null) tok.end - tok.start else 1)
        }

        fun parseUnary(depth: Int, start: Tok?): Match {
            var after = start
            var negate = false
            while (peek()?.type == "!") {
                after = tokens[pos++]
                negate = !negate
            }
            val inner = parsePrimary(depth, after)
            return if (negate) Match { !inner.test(it) } else inner
        }

        fun parseAnd(depth: Int, after: Tok?): Match {
            val parts = arrayListOf(parseUnary(depth, after))
            while (peek()?.type == "&") parts.add(parseUnary(depth, tokens[pos++]))
            if (parts.size == 1) return parts[0]
            return Match { t -> parts.all { it.test(t) } }
        }

        parseOr = { depth, after ->
            val parts = arrayListOf(parseAnd(depth, after))
            while (peek()?.type == "|") parts.add(parseAnd(depth, tokens[pos++]))
            if (parts.size == 1) parts[0] else Match { t -> parts.any { it.test(t) } }
        }

        val groups = ArrayList<Parsed>()
        var previous: Tok? = null
        while (true) {
            val named = if (peek()?.type == "name") tokens[pos++] else null
            val first = peek()
            val match = parseOr(0, named ?: previous)
            val lastTok = tokens[pos - 1]
            val next = peek()
            if (next != null && next.type != ",") failAt(if (next.type == ")") "unexpected_paren" else "expected_operator", next)
            groups.add(Parsed(named?.value ?: q.substring(first!!.start, lastTok.end), match))
            if (next == null) break
            previous = next
            pos++
        }
        return groups
    }

    // ---------- uitvoeren ----------

    /**
     * De taken bij een filter, zoals evaluateFilter in de web-app: taken in een gearchiveerd project doen niet mee, en de
     * volgorde is die van de overzichten (datum en tijdstip, zonder datum achteraan; prioriteit; de plek van het project; de
     * eigen volgorde).
     * @param tasks de open taken (standaard alle taken van [snapshot]; de widget laat net afgevinkte weg)
     */
    fun evaluate(query: String, snapshot: WidgetSnapshot, tasks: List<WidgetTask>, nowMs: Long, zone: ZoneId): Outcome {
        try {
            if (FilterText.trim(query).isEmpty()) fail("empty_query", 0, maxOf(1, query.length))
            if (query.length > MAX_QUERY_LENGTH) fail("too_long", MAX_QUERY_LENGTH, query.length - MAX_QUERY_LENGTH)
            val now = Instant.ofEpochMilli(nowMs).atZone(zone)
            val today = now.toLocalDate().toString()
            val nowStr = "${today}T${pad(now.hour, 2)}:${pad(now.minute, 2)}"
            val env = Env(query, today, nowStr, snapshot.accountId, snapshot)
            val groups = parse(query, lex(query), env)
            val archived = snapshot.projects.filter { it.archived }.mapTo(HashSet()) { it.id }
            val lists = groups.map { ArrayList<WidgetTask>() }
            val all = ArrayList<WidgetTask>()
            for (t in tasks) {
                if (t.projectId in archived) continue
                var hit = false
                for (i in groups.indices) {
                    if (groups[i].match.test(t)) {
                        lists[i].add(t)
                        hit = true
                    }
                }
                if (hit) all.add(t)
            }
            val order = sortOrder(snapshot)
            val sorted = lists.map { it.sortedWith(order) }
            return Outcome.Ok(
                if (sorted.size == 1) sorted[0] else all.sortedWith(order),
                groups.mapIndexed { i, g -> Group(g.name, sorted[i]) },
                env.completed,
            )
        } catch (e: Fail) {
            return Outcome.Failed(e.error)
        } catch (_: Exception) {
            return Outcome.Failed(Error("internal", 0, 1))
        } catch (_: StackOverflowError) {
            return Outcome.Failed(Error("internal", 0, 1))
        }
    }

    /** sortTasks uit filter.js. */
    private fun sortOrder(snapshot: WidgetSnapshot): Comparator<WidgetTask> {
        val rank = HashMap<String, Int>()
        snapshot.projects.sortedWith(compareBy<WidgetProject>({ it.orderKey }, { it.id })).forEachIndexed { i, p -> rank[p.id] = i }
        return Comparator { a, b ->
            val da = a.due
            val db = b.due
            if (da != db) return@Comparator if (da == null) 1 else if (db == null) -1 else da.compareTo(db)
            if (a.priority != b.priority) return@Comparator a.priority.compareTo(b.priority)
            val ra = rank[a.projectId] ?: Int.MAX_VALUE
            val rb = rank[b.projectId] ?: Int.MAX_VALUE
            if (ra != rb) return@Comparator ra.compareTo(rb)
            if (a.orderKey != b.orderKey) a.orderKey.compareTo(b.orderKey) else a.id.compareTo(b.id)
        }
    }
}

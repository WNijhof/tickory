package io.github.wnijhof.tickory.core

/**
 * Een notitie zoals de notitiewidget haar toont (zie widget/NotesWidget.kt): de kop, een paar regels tekst zonder Markdown,
 * de achtergrond, of ze vastgepind is, hoeveel punten van een checklist af zijn, en of ze van een ander is (met jou gedeeld).
 *
 * @property updatedAt het tijdstip van de laatste wijziging zoals de server het geeft (ISO), voor de volgorde
 */
data class WidgetNote(
    val id: String,
    val title: String,
    val excerpt: String,
    val background: String?,
    val pinned: Boolean,
    val updatedAt: String,
    val done: Int,
    val total: Int,
    val shared: Boolean,
)

/** Leest de notities uit een sync-antwoord voor de widget, en bepaalt de volgorde en de tekst. Zonder Android: te testen. */
object WidgetNotes {
    /** Meer notities bewaren we niet voor de widget. */
    const val MAX_NOTES = 200

    /** De achtergronden die de app kent (shared/notes.js); iets anders wordt de gewone kaart. */
    val BACKGROUNDS = setOf(
        "yellow", "orange", "brown", "red", "pink", "purple", "indigo", "blue", "teal", "green",
        "dots", "grid", "lines", "waves", "groceries", "music", "travel", "code",
    )

    // alle haken geëscaped: de reguliere expressies van Android (ICU) zijn daar strenger in dan die van Java
    private val CHECK = Regex("^\\s*[-*+]\\s+\\[([ xX])\\]\\s+")
    private val MARKERS = Regex("^\\s*(?:[-*+]|\\d{1,9}[.)]|#{1,6}|>)\\s+")
    private val LINK_TARGET = Regex("\\]\\([^)]*\\)")
    private val FORMATTING = Regex("[*_~=`+\\[\\]\\\\]|\\{(?:yellow|green|blue|pink|purple)\\}")

    /**
     * De notities die de widget toont: niet verwijderd, niet in de prullenbak en niet gearchiveerd, vastgepinde eerst en daarna de
     * laatst gewijzigde. Een notitie zonder geldig id slaan we over. [raw] is de lijst `notes` uit het antwoord (null: geen notities).
     */
    fun parse(raw: List<Any?>?, accountId: String): List<WidgetNote> {
        val out = ArrayList<WidgetNote>()
        for (entry in raw ?: emptyList()) {
            val o = Json.asObject(entry) ?: continue
            if (o.flag("is_deleted") || o.flag("is_archived") || o.text("trashed_at") != null) continue
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) && Ids.isSafeId(NoteReminders.taskIdFor(it)) } ?: continue
            val title = o.text("title").orEmpty()
            val content = o.text("content").orEmpty()
            val (done, total) = checklist(content)
            out.add(
                WidgetNote(
                    id = id,
                    title = SyncParser.cleanTitle(NoteReminders.headline(title, content)),
                    excerpt = excerpt(title, content),
                    background = o.text("background")?.takeIf { it in BACKGROUNDS },
                    pinned = o.flag("is_pinned"),
                    updatedAt = o.text("updated_at").orEmpty(),
                    done = done,
                    total = total,
                    shared = o.text("owner_id").let { it != null && it != accountId },
                ),
            )
        }
        return order(out).take(MAX_NOTES)
    }

    /** Vastgepind eerst, dan de laatst gewijzigde; bij gelijke tijd op id (vaste volgorde). */
    fun order(notes: List<WidgetNote>): List<WidgetNote> =
        notes.sortedWith(compareByDescending<WidgetNote> { it.pinned }.thenByDescending { it.updatedAt }.thenBy { it.id })

    /** Hoeveel punten van de checklist af zijn, en hoeveel er zijn. */
    fun checklist(content: String): Pair<Int, Int> {
        var done = 0
        var total = 0
        for (line in content.lineSequence()) {
            val m = CHECK.find(line) ?: continue
            total += 1
            if (m.groupValues[1] != " ") done += 1
        }
        return done to total
    }

    /**
     * Een paar regels tekst onder de kop, zonder Markdown-tekens: een punt van een checklist als "○ melk" of "✓ brood". Zonder
     * eigen titel is de eerste regel al de kop: die komt er niet nog eens onder.
     */
    fun excerpt(title: String, content: String, maxLines: Int = 4, maxChars: Int = 220): String {
        val lines = content.lineSequence().mapNotNull { line ->
            val check = CHECK.find(line)
            val text = (if (check != null) line.substring(check.range.last + 1) else line.replace(MARKERS, ""))
                .replace(LINK_TARGET, "").replace(FORMATTING, "").replace(Regex("\\s+"), " ").trim()
            when {
                text.isEmpty() -> null
                check != null -> (if (check.groupValues[1] == " ") "○ " else "✓ ") + text
                else -> text
            }
        }.toMutableList()
        if (title.isBlank() && lines.isNotEmpty()) lines.removeAt(0)
        val joined = lines.take(maxLines).joinToString("\n")
        if (joined.length <= maxChars) return joined
        var cut = joined.substring(0, maxChars - 1)
        if (cut.last().isHighSurrogate()) cut = cut.dropLast(1)
        return cut.trimEnd() + "…"
    }
}

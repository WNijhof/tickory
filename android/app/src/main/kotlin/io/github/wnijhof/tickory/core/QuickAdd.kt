package io.github.wnijhof.tickory.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.time.LocalDate
import java.time.format.DateTimeParseException

/**
 * Een taak die in het kleine venster "Taak toevoegen" is ingetypt en nog bij de server moet aankomen. De server
 * (`POST /api/v1/quick-add`) herkent datum, project, labels en prioriteit in [text], met dezelfde code als de web-app.
 *
 * @property uuid bij opnieuw proberen altijd hetzelfde: de server maakt de taak hooguit één keer
 * @property projectId het gekozen project; null is de Inbox (die kiest de server, zodat een verouderde Inbox-id niets uitmaakt)
 * @property due de knop Vandaag ("today") of Morgen ("tomorrow"), of null
 * @property priority de knop P1 … P4, of null; wat je typt (p1) gaat voor
 * @property typedAt wanneer de tekst is ingetypt, met de UTC-afwijking (2026-11-13T23:30+01:00): "morgen" telt vanaf dan
 * @property tz de tijdzone van het toestel bij het intypen
 * @property accountId van wie de taak is; null als dat bij het intypen nog niet vaststond (net ingelogd)
 * @property session vingerafdruk van de aanmelding bij het intypen (geen token): alleen voor een taak zonder [accountId]
 */
data class QueuedQuickAdd(
    val uuid: String,
    val text: String,
    val projectId: String?,
    val due: String?,
    val priority: Int?,
    val typedAt: String,
    val tz: String,
    val accountId: String?,
    val session: String,
    val queuedAtMs: Long,
)

/** De regels van de wachtrij van het kleine venster, als zuivere functies (de opslag staat in QuickAddStore). */
object QuickAddQueue {
    /** Zo lang proberen we het; daarna komt er een melding met de tekst, zodat er niets stil verloren gaat. */
    const val RETENTION_MS: Long = 14L * 24 * 60 * 60 * 1000

    /** Meer wachtende taken nemen we niet aan: dan klopt er iets niet (al dagen geen verbinding), en de app zegt dat. */
    const val MAX_ITEMS = 200

    /** Hooguit zoveel per verversing (één verzoek per taak); de rest komt de volgende keer. */
    const val PER_RUN = 25

    /** Langer mag de tekst niet zijn (de server weigert het anders). */
    const val MAX_TEXT = 4000

    const val DUE_TODAY = "today"
    const val DUE_TOMORROW = "tomorrow"

    private val random = SecureRandom()
    private val UUID = Regex("^[A-Za-z0-9_-]{8,56}$")
    private val TYPED_AT = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$")
    private val ZONE = Regex("^[A-Za-z0-9_+/-]{1,64}$")

    /** Een nieuw uuid: "tickory-q-" en 24 tekens uit [0-9a-f]; de server vraagt 8 tot 56 tekens uit [A-Za-z0-9_-]. */
    fun newUuid(nextByte: () -> Int = { random.nextInt(256) }): String {
        val sb = StringBuilder("tickory-q-")
        repeat(12) {
            val b = nextByte() and 0xff
            sb.append("0123456789abcdef"[b ushr 4]).append("0123456789abcdef"[b and 0x0f])
        }
        return sb.toString()
    }

    /** Een vingerafdruk van het token (16 tekens van SHA-256): daaraan is te zien of het nog dezelfde aanmelding is, niet wat het token is. */
    fun sessionTag(token: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("tickory-session|$token".toByteArray(Charsets.UTF_8))
        val sb = StringBuilder()
        for (i in 0 until 8) {
            val b = digest[i].toInt() and 0xff
            sb.append("0123456789abcdef"[b ushr 4]).append("0123456789abcdef"[b and 0x0f])
        }
        return sb.toString()
    }

    /** @return de nieuwe rij en of de taak erbij kwam (niet als hetzelfde uuid er al in staat of de rij vol is) */
    fun enqueue(items: List<QueuedQuickAdd>, item: QueuedQuickAdd): Pair<List<QueuedQuickAdd>, Boolean> = when {
        items.any { it.uuid == item.uuid } -> items to false
        items.size >= MAX_ITEMS -> items to false
        else -> (items + item) to true
    }

    fun settle(items: List<QueuedQuickAdd>, uuids: Set<String>): List<QueuedQuickAdd> = items.filter { it.uuid !in uuids }

    fun expired(items: List<QueuedQuickAdd>, nowMs: Long): List<QueuedQuickAdd> = items.filter { it.queuedAtMs < nowMs - RETENTION_MS }

    /**
     * Wat onder deze aanmelding verstuurd mag worden: van deze gebruiker, of (zonder gebruiker) van deze aanmelding.
     * @param accountId de gebruiker van de gecontroleerde gegevens, of null als die nog niet bekend is
     */
    fun sendable(items: List<QueuedQuickAdd>, accountId: String?, session: String?): List<QueuedQuickAdd> =
        items.filter { if (it.accountId != null) it.accountId == accountId else it.session == session }

    /**
     * Wat zeker niet van deze gebruiker is: van een andere gebruiker, of zonder gebruiker van een andere aanmelding. Alleen te
     * zeggen als de gebruiker bekend is; anders niets.
     */
    fun foreign(items: List<QueuedQuickAdd>, accountId: String?, session: String?): List<QueuedQuickAdd> =
        if (accountId == null) emptyList() else items.filter { if (it.accountId != null) it.accountId != accountId else it.session != session }

    /** Het verzoek aan `POST /api/v1/quick-add` voor deze taak. */
    fun requestBody(item: QueuedQuickAdd): String = Json.stringify(
        LinkedHashMap<String, Any?>().apply {
            put("text", item.text)
            if (item.projectId != null) put("project_id", item.projectId)
            put("uuid", item.uuid)
            put("typed_at", item.typedAt)
            put("tz", item.tz)
            if (item.due != null) put("due", item.due)
            if (item.priority != null) put("priority", item.priority.toLong())
        },
    )

    /** De voorvertoning tijdens het typen (`dry_run`): niets wordt aangemaakt. */
    fun previewBody(text: String, projectId: String?, due: String?, priority: Int?, typedAt: String, tz: String): String = Json.stringify(
        LinkedHashMap<String, Any?>().apply {
            put("text", text)
            if (projectId != null) put("project_id", projectId)
            put("typed_at", typedAt)
            put("tz", tz)
            if (due != null) put("due", due)
            if (priority != null) put("priority", priority.toLong())
            put("dry_run", true)
        },
    )

    fun encode(items: List<QueuedQuickAdd>): String = Json.stringify(
        mapOf(
            "v" to 1L,
            "items" to items.map {
                mapOf(
                    "uuid" to it.uuid, "text" to it.text, "project" to it.projectId, "due" to it.due, "priority" to it.priority?.toLong(),
                    "typedAt" to it.typedAt, "tz" to it.tz, "account" to it.accountId, "session" to it.session, "at" to it.queuedAtMs,
                )
            },
        ),
    )

    /** Leest de bewaarde rij; wat niet klopt (een kapot bestand, een vreemde regel) valt weg in plaats van een fout te geven. */
    fun decode(text: String?): List<QueuedQuickAdd> {
        val root = Json.parseObject(text) ?: return emptyList()
        if (root.whole("v") != 1L) return emptyList()
        return (root.list("items") ?: emptyList()).mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            QueuedQuickAdd(
                uuid = o.text("uuid")?.takeIf { UUID.matches(it) } ?: return@mapNotNull null,
                text = o.text("text")?.takeIf { it.isNotBlank() && it.length <= MAX_TEXT } ?: return@mapNotNull null,
                projectId = o.text("project")?.let { if (Ids.isSafeId(it)) it else return@mapNotNull null },
                due = o.text("due")?.let { if (it == DUE_TODAY || it == DUE_TOMORROW) it else return@mapNotNull null },
                priority = o.whole("priority")?.let { if (it in 1L..4L) it.toInt() else return@mapNotNull null },
                typedAt = o.text("typedAt")?.takeIf { TYPED_AT.matches(it) } ?: return@mapNotNull null,
                tz = o.text("tz")?.takeIf { ZONE.matches(it) } ?: return@mapNotNull null,
                accountId = o.text("account")?.let { if (Ids.isSafeId(it)) it else return@mapNotNull null },
                session = o.text("session")?.takeIf { Regex("^[0-9a-f]{16}$").matches(it) } ?: return@mapNotNull null,
                queuedAtMs = o.whole("at") ?: return@mapNotNull null,
            )
        }
    }

    /** Staat er in de tekst al een prioriteit (p1 … p4 of !!1 … !!4, als los woord)? Dezelfde regel als client/core/quickadd.js. */
    fun hasPriority(text: String): Boolean = Regex("(?<![^\\s])(?:p|!!)[1-4](?![\\p{L}\\p{N}_-])", RegexOption.IGNORE_CASE).containsMatchIn(text)

    /** De tekst voor "Openen in de app": met de gekozen prioriteit erachter als "p2" (de web-app herkent dat), tenzij je er al een typte. */
    fun textForApp(text: String, priority: Int?): String {
        val t = text.trim()
        return if (priority != null && priority in 1..3 && !hasPriority(t)) "$t p$priority" else t
    }
}

/** De datum van een taak zoals de server die geeft. */
data class PreviewDue(val date: String, val string: String?, val recurring: Boolean)

/** Een herinnering in de voorvertoning: [minuteOffset] vooraf, of op het tijdstip [date]. */
data class PreviewReminder(val minuteOffset: Int?, val date: String?)

/** Wat de server zegt dat de tekst wordt (`dry_run`), om als kleine labels onder het invoerveld te tonen. */
data class QuickAddPreview(
    val content: String,
    val due: PreviewDue?,
    val deadline: String?,
    val projectId: String,
    val projectName: String,
    val inbox: Boolean,
    val sectionName: String?,
    val labels: List<Pair<String, Boolean>>,
    val priority: Int,
    val reminders: List<PreviewReminder>,
)

object QuickAddParser {
    /** Is dit een antwoord van het eindpunt (ook bij een weigering)? Een oudere server kent het niet en antwoordt zonder `quick_add`. */
    fun isQuickAdd(body: String?): Boolean = Json.parseObject(body)?.whole("quick_add")?.let { it >= 1 } == true

    fun taskId(body: String?): String? = Json.parseObject(body)?.obj("task")?.text("id")?.takeIf(Ids::isSafeId)

    fun preview(body: String?): QuickAddPreview? {
        val p = Json.parseObject(body)?.obj("preview") ?: return null
        val project = p.obj("project") ?: return null
        val due = p.obj("due")?.let { d -> d.text("date")?.let { PreviewDue(it, d.text("string"), d.obj("recurrence") != null) } }
        return QuickAddPreview(
            content = SyncParser.cleanTitle(p.text("content")),
            due = due,
            deadline = p.text("deadline"),
            projectId = project.text("id")?.takeIf(Ids::isSafeId) ?: return null,
            projectName = SyncParser.cleanTitle(project.text("name")),
            inbox = project["inbox"] == true,
            sectionName = p.obj("section")?.text("name")?.let(SyncParser::cleanTitle),
            labels = (p.list("labels") ?: emptyList()).mapNotNull { e -> Json.asObject(e)?.let { o -> o.text("name")?.let { SyncParser.cleanTitle(it) to (o["new"] == true) } } },
            priority = p.whole("priority")?.toInt()?.takeIf { it in 1..4 } ?: 4,
            reminders = (p.list("reminders") ?: emptyList()).mapNotNull { e ->
                val o = Json.asObject(e) ?: return@mapNotNull null
                when (o.text("type")) {
                    "relative" -> o.whole("minute_offset")?.let { PreviewReminder(it.toInt(), null) }
                    "absolute" -> o.text("date")?.let { PreviewReminder(null, it) }
                    else -> null
                }
            },
        )
    }

    /** Is dit een datum 'YYYY-MM-DD' die bestaat? */
    fun isDay(value: String?): Boolean = value != null && value.length == 10 && try {
        LocalDate.parse(value)
        true
    } catch (_: DateTimeParseException) {
        false
    }
}

/** Een project in de keuzelijst van het kleine venster; [id] null is de Inbox. */
data class QuickAddChoice(val id: String?, val name: String, val depth: Int)

/** Waar je in het kleine venster een taak in kunt zetten. */
object QuickAddChoices {
    /**
     * De Inbox, dan alle projecten die niet (onder een) gearchiveerd (project) zijn en waar je niet alleen lezer bent, in de
     * volgorde van de projectenboom. Een subproject onder een project dat je alleen leest, staat er wel, op zijn eigen diepte.
     */
    fun list(snapshot: WidgetSnapshot?, inboxName: String): List<QuickAddChoice> {
        val out = arrayListOf(QuickAddChoice(null, snapshot?.inboxId?.let { snapshot.project(it)?.name?.takeIf(String::isNotBlank) } ?: inboxName, 0))
        if (snapshot == null) return out
        val visible = snapshot.projects.filter { it.id != snapshot.inboxId && !WidgetChoices.isArchived(snapshot, it.id) }
        val ids = visible.mapTo(HashSet()) { it.id }
        val children = visible.groupBy { if (it.parentId != null && it.parentId in ids) it.parentId else null }
        fun walk(parent: String?, depth: Int, seen: Set<String>) {
            for (p in (children[parent] ?: emptyList()).sortedWith(compareBy({ it.orderKey }, { it.id }))) {
                if (p.id in seen) continue
                if (!p.readOnly) out.add(QuickAddChoice(p.id, p.name, depth))
                walk(p.id, depth + 1, seen + p.id)
            }
        }
        walk(null, 0, emptySet())
        return out
    }

    /**
     * Welk project het venster eerst kiest: dat van de widget (als je daar iets in mag zetten), anders het laatst gekozen, anders
     * de Inbox (null).
     */
    fun initial(choices: List<QuickAddChoice>, fromWidget: String?, last: String?, inboxId: String?): String? {
        val ids = choices.mapNotNullTo(HashSet()) { it.id }
        return when {
            fromWidget != null && fromWidget == inboxId -> null
            fromWidget != null && fromWidget in ids -> fromWidget
            last != null && last in ids -> last
            else -> null
        }
    }
}

package io.github.wnijhof.tickory.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Eén regel in een lijstwidget. */
sealed class WidgetRow {
    /** Een kop: een dag (Binnenkort) of een sectie (project). */
    data class Header(val text: String) : WidgetRow()

    /**
     * @property due de datum als korte tekst ("14:00", "morgen", "wo 18 nov 09:30"), of null
     * @property overdue vóór vandaag (alleen op de dag zelf, niet op de tijd)
     * @property depth 0 = taak, 1 = subtaak, enzovoort (hooguit 3)
     * @property meta het project (in lijsten over meerdere projecten) en de labels, bijvoorbeeld "Werk · @bellen"
     * @property readOnly de taak staat in een project waar de gebruiker alleen lezer is: geen cirkel om af te vinken
     */
    data class Item(
        val id: String,
        val title: String,
        val priority: Int,
        val due: String?,
        val overdue: Boolean,
        val depth: Int,
        val meta: String?,
        val readOnly: Boolean = false,
    ) : WidgetRow()
}

enum class ContentKind { TODAY, UPCOMING, PROJECT, UNSUPPORTED }

/**
 * Wat een widget toont.
 * @property count het aantal taken (niet het aantal regels, en vóór het inkorten)
 * @property projectName de naam van het project bij [ContentKind.PROJECT]
 * @property missing het project bestaat niet (meer) voor deze gebruiker: verwijderd, of geen lid meer
 */
data class WidgetContent(
    val kind: ContentKind,
    val projectName: String?,
    val rows: List<WidgetRow>,
    val count: Int,
    val missing: Boolean = false,
)

/**
 * Bouwt de regels van een widget uit de bewaarde gegevens. Zuivere Kotlin: geen Android, geen klok (die komt van buiten),
 * dus op de pc te testen, ook rond de tijdzone en het middernachtelijk uur.
 *
 * De regels volgen die van de web-app (client/core/selectors.js): Vandaag is wat open staat en een datum heeft vóór of op
 * vandaag, eerst op tijdstip, dan op prioriteit, dan op eigen volgorde; Binnenkort loopt vanaf morgen veertien dagen;
 * een project toont de taken per sectie, als boom. Datums zijn "zwevend": 14:00 is 14:00 op het toestel.
 */
object WidgetContentBuilder {
    const val MAX_ROWS = 200
    const val UPCOMING_DAYS = 14L
    private const val MAX_DEPTH = 3

    /**
     * @param hidden taken die de gebruiker net heeft afgevinkt maar waarvan de server het nog niet bevestigde; ze zijn niet
     *   te zien, en hun subtaken ook niet (afvinken sluit die mee, behalve bij een terugkerende taak)
     */
    fun build(
        snapshot: WidgetSnapshot,
        source: WidgetSource,
        hidden: Set<String>,
        nowMs: Long,
        zone: ZoneId,
        lang: Lang,
        use24Hour: Boolean = true,
        maxRows: Int = MAX_ROWS,
    ): WidgetContent {
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        val ctx = Ctx(snapshot, today, nowMs, zone, lang, use24Hour)
        val gone = hideWithSubtasks(snapshot, hidden)
        val open = snapshot.tasks.filter { it.id !in gone }
        return when (source) {
            WidgetSource.Today -> today(ctx, open, maxRows)
            WidgetSource.Upcoming -> upcoming(ctx, open, maxRows)
            WidgetSource.Inbox -> project(ctx, open, snapshot.inboxId, maxRows)
            is WidgetSource.Project -> project(ctx, open, source.id, maxRows)
            is WidgetSource.Filter -> WidgetContent(ContentKind.UNSUPPORTED, null, emptyList(), 0)
        }
    }

    private class Ctx(val snapshot: WidgetSnapshot, val today: LocalDate, val nowMs: Long, val zone: ZoneId, val lang: Lang, val use24Hour: Boolean) {
        val projectNames = snapshot.projects.associate { it.id to it.name }
        val labelNames = snapshot.labels.associate { it.id to it.name }
        val readOnly = snapshot.projects.filter { it.readOnly }.mapTo(HashSet()) { it.id }
    }

    /** De verborgen taken plus, bij een gewone taak, alles eronder. Een terugkerende taak blijft open, dus zijn subtaken ook. */
    fun hideWithSubtasks(snapshot: WidgetSnapshot, hidden: Set<String>): Set<String> {
        if (hidden.isEmpty()) return hidden
        val byParent = snapshot.tasks.groupBy { it.parentId }
        val out = HashSet(hidden)
        val todo = ArrayDeque<String>()
        for (id in hidden) if (snapshot.tasks.firstOrNull { it.id == id }?.recurring == false) todo.add(id)
        while (todo.isNotEmpty()) {
            val id = todo.removeFirst()
            for (child in byParent[id] ?: emptyList()) if (out.add(child.id)) todo.add(child.id)
        }
        return out
    }

    /** Op tijdstip (de tekst, zoals de web-app), dan prioriteit (1 = hoogst), dan eigen volgorde, dan id. */
    private val byDue = Comparator<WidgetTask> { a, b ->
        val ad = a.due ?: ""
        val bd = b.due ?: ""
        if (ad != bd) return@Comparator ad.compareTo(bd)
        if (a.priority != b.priority) return@Comparator a.priority.compareTo(b.priority)
        byOrder.compare(a, b)
    }
    private val byOrder = Comparator<WidgetTask> { a, b -> if (a.orderKey != b.orderKey) a.orderKey.compareTo(b.orderKey) else a.id.compareTo(b.id) }

    private fun dayOf(task: WidgetTask): LocalDate? = Planner.localDate(task.due)

    private fun today(ctx: Ctx, open: List<WidgetTask>, maxRows: Int): WidgetContent {
        val dated = open.mapNotNull { t -> dayOf(t)?.let { t to it } }.filter { (_, day) -> day <= ctx.today }
        val sorted = dated.map { it.first }.sortedWith(byDue)
        val rows = sorted.map { item(ctx, it, sourceIsProject = false, depth = 0, timeOnly = true) }
        return WidgetContent(ContentKind.TODAY, null, rows.take(maxRows), rows.size)
    }

    private fun upcoming(ctx: Ctx, open: List<WidgetTask>, maxRows: Int): WidgetContent {
        val last = ctx.today.plusDays(UPCOMING_DAYS)
        val perDay = open.mapNotNull { t -> dayOf(t)?.let { t to it } }
            .filter { (_, day) -> day > ctx.today && day <= last }
            .groupBy({ it.second }, { it.first })
        val rows = ArrayList<WidgetRow>()
        var count = 0
        for (day in perDay.keys.sorted()) {
            rows.add(WidgetRow.Header(dayHeader(ctx, day)))
            for (t in perDay.getValue(day).sortedWith(byDue)) {
                rows.add(item(ctx, t, sourceIsProject = false, depth = 0, timeOnly = true))
                count++
            }
        }
        return WidgetContent(ContentKind.UPCOMING, null, capped(rows, maxRows), count)
    }

    private fun dayHeader(ctx: Ctx, day: LocalDate): String {
        val text = DueText.format(day.toString(), ctx.nowMs, ctx.zone, ctx.lang) ?: day.toString()
        return text.replaceFirstChar { it.uppercase() }
    }

    private fun project(ctx: Ctx, open: List<WidgetTask>, projectId: String?, maxRows: Int): WidgetContent {
        val project = projectId?.let { ctx.snapshot.project(it) }
            ?: return WidgetContent(ContentKind.PROJECT, null, emptyList(), 0, missing = true)
        val mine = open.filter { it.projectId == project.id }
        val sections = ctx.snapshot.sections.filter { it.projectId == project.id && !it.archived }.sortedWith(compareBy({ it.orderKey }, { it.id }))
        val known = sections.mapTo(HashSet()) { it.id }
        val rows = ArrayList<WidgetRow>()
        var count = 0
        fun group(tasks: List<WidgetTask>) {
            for ((task, depth) in tree(tasks)) {
                rows.add(item(ctx, task, sourceIsProject = true, depth = depth, timeOnly = false))
                count++
            }
        }
        group(mine.filter { it.sectionId == null || it.sectionId !in known })
        for (section in sections) {
            val inSection = mine.filter { it.sectionId == section.id }
            if (inSection.isEmpty()) continue
            rows.add(WidgetRow.Header(section.name))
            group(inSection)
        }
        return WidgetContent(ContentKind.PROJECT, project.name, capped(rows, maxRows), count)
    }

    /** Taken als boom, platgeslagen met inspringniveau. Een taak zonder ouder in dezelfde lijst staat op het hoogste niveau. */
    private fun tree(tasks: List<WidgetTask>): List<Pair<WidgetTask, Int>> {
        val ids = tasks.mapTo(HashSet()) { it.id }
        val children = tasks.groupBy { if (it.parentId != null && it.parentId in ids) it.parentId else null }
        val out = ArrayList<Pair<WidgetTask, Int>>()
        val seen = HashSet<String>()
        fun walk(parent: String?, depth: Int) {
            for (t in (children[parent] ?: emptyList()).sortedWith(byOrder)) {
                if (!seen.add(t.id)) continue
                out.add(t to minOf(depth, MAX_DEPTH))
                walk(t.id, depth + 1)
            }
        }
        walk(null, 0)
        return out
    }

    private fun item(ctx: Ctx, t: WidgetTask, sourceIsProject: Boolean, depth: Int, timeOnly: Boolean): WidgetRow.Item {
        val day = dayOf(t)
        val overdue = day != null && day < ctx.today
        val due = when {
            t.due == null || day == null -> null
            timeOnly && day >= ctx.today -> Planner.localDateTime(t.due)?.toLocalTime()?.let { DueText.clock(it, ctx.lang, ctx.use24Hour) }
            else -> DueText.format(t.due, ctx.nowMs, ctx.zone, ctx.lang, ctx.use24Hour)
        }
        val meta = buildList {
            if (!sourceIsProject) ctx.projectNames[t.projectId]?.takeIf { it.isNotBlank() }?.let { add(it) }
            t.labelIds.mapNotNull { ctx.labelNames[it]?.takeIf { n -> n.isNotBlank() } }.take(2).forEach { add("@$it") }
        }.joinToString(" · ").ifEmpty { null }
        return WidgetRow.Item(t.id, t.content, t.priority, due, overdue, depth, meta, t.projectId in ctx.readOnly)
    }

    private fun capped(rows: List<WidgetRow>, max: Int): List<WidgetRow> {
        if (rows.size <= max) return rows
        val cut = rows.take(max)
        return if (cut.last() is WidgetRow.Header) cut.dropLast(1) else cut // geen kop zonder taken eronder
    }
}

/** Hoe groot een widget is, in drie klassen; de widgets kiezen daarmee een compacte of ruime opmaak. */
enum class WidgetSize {
    SMALL, MEDIUM, LARGE;

    companion object {
        /** @param widthDp en [heightDp] de minimale afmetingen die de launcher opgeeft (OPTION_APPWIDGET_MIN_WIDTH/HEIGHT) */
        fun of(widthDp: Int, heightDp: Int): WidgetSize = when {
            widthDp <= 0 || heightDp <= 0 -> MEDIUM // de launcher gaf niets op
            heightDp < 110 || widthDp < 160 -> SMALL
            heightDp >= 300 && widthDp >= 250 -> LARGE
            else -> MEDIUM
        }
    }
}

package io.github.wnijhof.tickory.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Eén regel in een lijstwidget. */
sealed class WidgetRow {
    /** Een kop: een dag (Binnenkort) of een sectie (project). */
    /** @property taskIds bij "Over tijd": de taken eronder (open), voor de knop Herplannen */
    data class Header(val text: String, val overdue: Boolean = false, val taskIds: List<String> = emptyList()) : WidgetRow()

    /**
     * @property due de datum als korte tekst ("14:00", "morgen", "wo 18 nov 09:30"), of null
     * @property overdue vóór vandaag (alleen op de dag zelf, niet op de tijd)
     * @property depth 0 = taak, 1 = subtaak, enzovoort (hooguit 3)
     * @property meta het project (in lijsten over meerdere projecten) en de labels, bijvoorbeeld "Werk · @bellen"
     * @property readOnly de taak staat in een project waar de gebruiker alleen lezer is: geen cirkel om af te vinken
     * @property dueKind hoe de datum gekleurd wordt: te laat, vandaag, morgen, de komende week, later
     * @property recurring de taak herhaalt zich; [deadline] heeft een deadline; [reminder] heeft een herinnering
     * @property subtasks het aantal open subtaken direct onder deze taak
     * @property project de naam van het project (rechts op de regel), alleen in lijsten over meerdere projecten; [inbox] is het de Inbox
     * @property labels de labels, bijvoorbeeld "@bellen @thuis" (hooguit twee)
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
        val dueKind: DueKind = DueKind.NONE,
        val recurring: Boolean = false,
        val deadline: Boolean = false,
        val reminder: Boolean = false,
        val subtasks: Int = 0,
        val project: String? = null,
        val inbox: Boolean = false,
        val labels: String? = null,
        /** Net afgevinkt (nog niet door de server bevestigd): doorgestreept, met een volle cirkel; een tik zet hem terug (zoals Todoist). */
        val done: Boolean = false,
        /** Afgevinkte subtaken, voor "1/3" (met [subtasks] open). */
        val subtasksDone: Int = 0,
        val reminders: Int = 0,
        val comments: Int = 0,
        val description: Boolean = false,
    ) : WidgetRow()
}

enum class ContentKind { TODAY, UPCOMING, PROJECT, FILTER }

/**
 * Wat een widget toont.
 * @property count het aantal taken (niet het aantal regels, en vóór het inkorten)
 * @property projectName de naam van het project bij [ContentKind.PROJECT], of van het filter bij [ContentKind.FILTER]
 * @property missing het project of filter bestaat niet (meer) voor deze gebruiker: verwijderd, of geen lid meer
 * @property filterError het filter is hier niet te lezen (zie [FilterLang]); [problem] is het stuk van de zoekopdracht waar het
 *   om gaat, zoals de web-app het aanwijst
 */
data class WidgetContent(
    val kind: ContentKind,
    val projectName: String?,
    val rows: List<WidgetRow>,
    val count: Int,
    val missing: Boolean = false,
    val filterError: FilterLang.Error? = null,
    val problem: String? = null,
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

    /** De kop boven te late taken; de widget vertaalt hem (WidgetRow.Header.overdue). */
    const val OVERDUE_HEADER = "overdue"
    const val UPCOMING_DAYS = 14L
    private const val MAX_DEPTH = 3

    /**
     * @param hidden taken die de gebruiker net heeft afgevinkt maar waarvan de server het nog niet bevestigde; hun subtaken zijn niet
     *   te zien (afvinken sluit die mee, behalve bij een terugkerende taak), en zijzelf ook niet, tenzij ze ook in [done] staan
     * @param done de taken uit [hidden] die zoals in Todoist blijven staan, doorgestreept, tot de volgende verversing (tellen niet mee)
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
        done: Set<String> = emptySet(),
    ): WidgetContent {
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        val shownDone = done.filterTo(HashSet()) { snapshot.tasks.firstOrNull { t -> t.id == it }?.recurring == false }
        val ctx = Ctx(snapshot, today, nowMs, zone, lang, use24Hour, shownDone)
        val gone = hideWithSubtasks(snapshot, hidden) - shownDone
        val open = snapshot.tasks.filter { it.id !in gone }
        val content = when (source) {
            WidgetSource.Today -> today(ctx, open, maxRows)
            WidgetSource.Upcoming -> upcoming(ctx, open, maxRows)
            WidgetSource.Inbox -> project(ctx, open, snapshot.inboxId, maxRows)
            is WidgetSource.Project -> project(ctx, open, source.id, maxRows)
            is WidgetSource.Filter -> filter(ctx, open, source.id, maxRows)
            is WidgetSource.Preset -> query(ctx, open, source.query, "", maxRows)
            is WidgetSource.Label -> label(ctx, open, source.id, maxRows)
        }
        if (shownDone.isEmpty()) return content
        // wat net is afgevinkt telt niet meer mee
        val doneRows = content.rows.count { it is WidgetRow.Item && it.done }
        return content.copy(count = maxOf(0, content.count - doneRows))
    }

    private class Ctx(val snapshot: WidgetSnapshot, val today: LocalDate, val nowMs: Long, val zone: ZoneId, val lang: Lang, val use24Hour: Boolean, val done: Set<String> = emptySet()) {
        val projectNames = snapshot.projects.associate { it.id to it.name }
        val labelNames = snapshot.labels.associate { it.id to it.name }
        val readOnly = snapshot.projects.filter { it.readOnly }.mapTo(HashSet()) { it.id }
        val subtaskCounts: Map<String, Int> = snapshot.tasks.filter { it.parentId != null }.groupingBy { it.parentId!! }.eachCount()
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

    /** Zoals applyDayOrder in shared/dayOrder.js: eerst de taken uit je eigen volgorde (in die volgorde), dan de rest zoals ze stonden. */
    fun applyDayOrder(tasks: List<WidgetTask>, order: List<String>): List<WidgetTask> {
        if (order.isEmpty()) return tasks
        val index = HashMap<String, Int>()
        order.forEachIndexed { i, id -> index.putIfAbsent(id, i) }
        return tasks.filter { it.id in index }.sortedBy { index.getValue(it.id) } + tasks.filter { it.id !in index }
    }

    private fun today(ctx: Ctx, open: List<WidgetTask>, maxRows: Int): WidgetContent {
        val dated = open.mapNotNull { t -> dayOf(t)?.let { t to it } }.filter { (_, day) -> day <= ctx.today }
        // zoals Vandaag in de web-app: eerst wat te laat is, dan vandaag; elk op tijdstip en prioriteit, met je eigen volgorde erover
        val overdue = dated.filter { (_, day) -> day < ctx.today }.map { it.first }.sortedWith(byDue)
        val dueToday = dated.filter { (_, day) -> day == ctx.today }.map { it.first }.sortedWith(byDue)
        val rows = ArrayList<WidgetRow>()
        // zoals in Todoist: "Over tijd" (met Herplannen) en daaronder de dag van vandaag; zonder te late taken geen koppen
        if (overdue.isNotEmpty()) rows.add(WidgetRow.Header(OVERDUE_HEADER, overdue = true, taskIds = overdue.filter { it.id !in ctx.done }.map { it.id }))
        for (t in applyDayOrder(overdue, ctx.snapshot.dayOrder)) rows.add(item(ctx, t, sourceIsProject = false, depth = 0, timeOnly = true))
        if (overdue.isNotEmpty() && dueToday.isNotEmpty()) rows.add(WidgetRow.Header(DueText.dayLong(ctx.today, ctx.today, ctx.lang)))
        for (t in applyDayOrder(dueToday, ctx.snapshot.dayOrder)) rows.add(item(ctx, t, sourceIsProject = false, depth = 0, timeOnly = true))
        val count = overdue.size + dueToday.size
        return WidgetContent(ContentKind.TODAY, null, capped(rows, maxRows), count)
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

    /**
     * Een opgeslagen filter: de taken in de volgorde van de web-app; bij meer lijsten (komma's) een kop per lijst, lege lijsten
     * weggelaten. Kan de widget het filter niet lezen (een datum in gewone taal), dan geen taken maar de fout.
     */
    private fun filter(ctx: Ctx, open: List<WidgetTask>, filterId: String, maxRows: Int): WidgetContent {
        val filter = ctx.snapshot.filters.firstOrNull { it.id == filterId }
            ?: return WidgetContent(ContentKind.FILTER, null, emptyList(), 0, missing = true)
        return query(ctx, open, filter.query, filter.name, maxRows)
    }

    /** Alle open taken met dit label, op datum (dan prioriteit) gesorteerd; een label dat er niet meer is, geeft "bestaat niet meer". */
    private fun label(ctx: Ctx, open: List<WidgetTask>, labelId: String, maxRows: Int): WidgetContent {
        val name = ctx.labelNames[labelId] ?: return WidgetContent(ContentKind.FILTER, null, emptyList(), 0, missing = true)
        val tasks = open.filter { labelId in it.labelIds }.sortedWith(compareBy<WidgetTask>({ dayOf(it) ?: LocalDate.MAX }, { it.priority }).then(byOrder))
        val rows = tasks.map { item(ctx, it, sourceIsProject = false, depth = 0, timeOnly = false) }
        return WidgetContent(ContentKind.FILTER, name, capped(rows, maxRows), rows.size)
    }

    /** Een zoekopdracht in de filtertaal (een opgeslagen filter of een vast filter) als lijst; [name] is de titel, leeg: de widget kiest hem. */
    private fun query(ctx: Ctx, open: List<WidgetTask>, text: String, name: String, maxRows: Int): WidgetContent {
        val filter = WidgetFilter("", name, text, "")
        return when (val outcome = FilterLang.evaluate(filter.query, ctx.snapshot, open, ctx.nowMs, ctx.zone)) {
            is FilterLang.Outcome.Failed -> {
                val e = outcome.error
                val problem = filter.query.substring(e.position.coerceIn(0, filter.query.length), (e.position + e.length).coerceIn(0, filter.query.length))
                WidgetContent(ContentKind.FILTER, filter.name, emptyList(), 0, filterError = e, problem = problem.trim().ifEmpty { null })
            }
            is FilterLang.Outcome.Ok -> {
                val rows = ArrayList<WidgetRow>()
                if (outcome.groups.size == 1) {
                    for (t in outcome.tasks) rows.add(item(ctx, t, sourceIsProject = false, depth = 0, timeOnly = false))
                } else {
                    for (group in outcome.groups) {
                        if (group.tasks.isEmpty()) continue
                        rows.add(WidgetRow.Header(group.name))
                        for (t in group.tasks) rows.add(item(ctx, t, sourceIsProject = false, depth = 0, timeOnly = false))
                    }
                }
                WidgetContent(ContentKind.FILTER, filter.name, capped(rows, maxRows), outcome.tasks.size)
            }
        }
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
        val kind = when {
            day == null -> DueKind.NONE
            day < ctx.today -> DueKind.OVERDUE
            day == ctx.today -> DueKind.TODAY
            day == ctx.today.plusDays(1) -> DueKind.TOMORROW
            day <= ctx.today.plusDays(6) -> DueKind.SOON
            else -> DueKind.LATER
        }
        val labels = t.labelIds.mapNotNull { ctx.labelNames[it]?.takeIf { n -> n.isNotBlank() } }.take(2).joinToString(" ") { "@$it" }.ifEmpty { null }
        val project = if (sourceIsProject) null else ctx.projectNames[t.projectId]?.takeIf { it.isNotBlank() }
        return WidgetRow.Item(
            t.id, t.content, t.priority, due, overdue, depth, meta, t.projectId in ctx.readOnly,
            dueKind = kind, recurring = t.recurring && t.due != null, deadline = t.deadline, reminder = t.hasReminder,
            subtasks = ctx.subtaskCounts[t.id] ?: 0, project = project, inbox = t.projectId == ctx.snapshot.inboxId, labels = labels,
            done = t.id in ctx.done, subtasksDone = t.doneSubtasks, reminders = t.reminders, comments = t.comments, description = t.hasDescription,
        )
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

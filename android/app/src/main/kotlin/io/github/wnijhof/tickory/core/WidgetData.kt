package io.github.wnijhof.tickory.core

/**
 * Een open taak zoals de widgets die nodig hebben. [due] is de datum zoals de server die geeft ("2026-11-13" of "2026-11-13T14:00").
 * De laatste vier velden zijn voor opgeslagen filters (zie [FilterLang]): [search] is de titel en de beschrijving, gevouwen zoals
 * de web-app zoekt; [hasReminder] zegt of er een eigen herinnering is die kan afgaan.
 */
data class WidgetTask(
    val id: String,
    val projectId: String,
    val sectionId: String?,
    val parentId: String?,
    val content: String,
    val due: String?,
    /** Heeft de taak een herhaling? Dan schuift de server de datum door bij afvinken in plaats van de taak te sluiten. */
    val recurring: Boolean,
    /** 1 = hoogst … 4 = geen. */
    val priority: Int,
    val labelIds: List<String>,
    val orderKey: String,
    val search: String = "",
    val deadline: Boolean = false,
    val assigneeId: String? = null,
    val hasReminder: Boolean = false,
)

/** @property readOnly de gebruiker is in dit project lezer (alleen lezen): de widget toont dan geen cirkel om af te vinken */
data class WidgetProject(
    val id: String,
    val name: String,
    val parentId: String?,
    val archived: Boolean,
    val orderKey: String,
    val readOnly: Boolean = false,
)

data class WidgetSection(
    val id: String,
    val projectId: String,
    val name: String,
    val archived: Boolean,
    val orderKey: String,
)

data class WidgetLabel(val id: String, val name: String)

/** Een opgeslagen filter van de gebruiker (de zoekopdracht in de filtertaal, zie [FilterLang]). */
data class WidgetFilter(val id: String, val name: String, val query: String, val orderKey: String)

/** Iemand met wie de gebruiker samenwerkt (of de gebruiker zelf), voor "toegewezen aan: naam" in een filter. */
data class WidgetUser(val id: String, val name: String, val username: String)

/**
 * Wat de widgets van de gegevens van de gebruiker weten: de open taken, de projecten, de secties en de labels van de
 * laatste geslaagde verversing. Alleen wat de server aan deze gebruiker liet zien (gedeelde projecten: alleen die waar
 * hij lid van is); de server stuurt niets anders.
 *
 * @property accountId het id van de gebruiker van wie dit is; wisselt dat, dan gaat alles weg (zie WidgetStore)
 * @property inboxId het project dat de Inbox van deze gebruiker is
 * @property notes de notities voor de notitiewidget (eigen en met de gebruiker gedeelde), in de volgorde van [WidgetNotes.order]
 * @property filters de opgeslagen filters, in hun eigen volgorde
 * @property users de mensen uit het sync-antwoord (`users`), voor filters op toewijzing
 */
data class WidgetSnapshot(
    val accountId: String,
    val inboxId: String?,
    val tasks: List<WidgetTask>,
    val projects: List<WidgetProject>,
    val sections: List<WidgetSection>,
    val labels: List<WidgetLabel>,
    val notes: List<WidgetNote> = emptyList(),
    val filters: List<WidgetFilter> = emptyList(),
    val users: List<WidgetUser> = emptyList(),
) {
    fun project(id: String): WidgetProject? = projects.firstOrNull { it.id == id }
}

/** Leest het antwoord van de server (`POST /api/v1/sync` met taken, projecten, secties, labels en leden) naar [WidgetSnapshot]. */
object WidgetParser {
    /** Meer open taken bewaren we niet voor de widgets: een lijst op een scherm van een telefoon is al lang ingekort. */
    const val MAX_TASKS = 5000

    /** Zoveel tekens van een beschrijving tellen mee voor "zoek:" in een filter (de rest zou de opslag onnodig groot maken). */
    const val MAX_SEARCH_DESCRIPTION = 4000

    /** Zoveel filters en mensen bewaren we hooguit. */
    const val MAX_FILTERS = 500
    const val MAX_USERS = 1000

    private val FLOATING = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?$")

    /**
     * De taken met een eigen herinnering die kan afgaan, zoals "heeft herinnering" in de web-app (reminderMoment en
     * isLocationActive in shared/reminders.js): absoluut met een tijdstip, relatief bij een taak met een tijdstip, of op een plek.
     * Herinneringen van een ander tellen niet.
     */
    private fun withReminder(raw: List<Any?>?, accountId: String, dueOf: Map<String, String?>): Set<String> {
        val out = HashSet<String>()
        for (entry in raw ?: emptyList()) {
            val r = Json.asObject(entry) ?: continue
            if (r.flag("is_deleted")) continue
            val owner = r.text("owner_id")
            if (!owner.isNullOrEmpty() && owner != accountId) continue
            val taskId = r.text("task_id") ?: continue
            if (taskId !in dueOf) continue
            val active = when (r.text("type")) {
                "absolute" -> r.obj("due")?.text("date")?.let { FLOATING.matches(it) } == true
                "relative" -> dueOf[taskId]?.let { FLOATING.matches(it) } == true && (r.whole("minute_offset") ?: -1) >= 0
                "location" -> true
                else -> false
            }
            if (active) out.add(taskId)
        }
        return out
    }

    /**
     * @return null als het antwoord onbruikbaar is (geen JSON-object, geen gebruiker, geen lijst met taken of projecten);
     *   de widgets laten dan staan wat er was. Losse onderdelen met een fout worden overgeslagen.
     */
    fun parse(body: String?): WidgetSnapshot? {
        val root = Json.parseObject(body) ?: return null
        val me = root.obj("me") ?: return null
        val accountId = me.text("id")?.takeIf { Ids.isSafeId(it) } ?: return null
        val rawTasks = root.list("tasks") ?: return null
        val rawProjects = root.list("projects") ?: return null

        val tasks = ArrayList<WidgetTask>()
        val openDue = HashMap<String, String?>()
        for (entry in rawTasks) {
            val o = Json.asObject(entry) ?: continue
            if (o.flag("is_deleted") || o.flag("checked")) continue
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: continue
            if (o.text("project_id")?.takeIf { Ids.isSafeId(it) } == null) continue
            openDue[id] = o.obj("due")?.text("date")
            if (openDue.size >= MAX_TASKS) break
        }
        val reminded = withReminder(root.list("reminders"), accountId, openDue)
        for (entry in rawTasks) {
            val o = Json.asObject(entry) ?: continue
            if (o.flag("is_deleted") || o.flag("checked")) continue
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: continue
            val projectId = o.text("project_id")?.takeIf { Ids.isSafeId(it) } ?: continue
            val due = o.obj("due")
            val content = o.text("content") ?: ""
            val description = (o.text("description") ?: "").take(MAX_SEARCH_DESCRIPTION)
            tasks.add(
                WidgetTask(
                    id = id,
                    projectId = projectId,
                    sectionId = o.text("section_id")?.takeIf { Ids.isSafeId(it) },
                    parentId = o.text("parent_id")?.takeIf { Ids.isSafeId(it) },
                    content = SyncParser.cleanTitle(o.text("content")),
                    due = due?.text("date"),
                    recurring = due?.obj("recurrence") != null,
                    priority = o.whole("priority")?.toInt()?.takeIf { it in 1..4 } ?: 4,
                    labelIds = o.list("labels")?.mapNotNull { (it as? String)?.takeIf { l -> Ids.isSafeId(l) } } ?: emptyList(),
                    orderKey = o.text("order_key") ?: "",
                    search = FilterText.fold(FilterText.nfc(content)) + "\n" + FilterText.fold(FilterText.nfc(description)),
                    deadline = !o.text("deadline").isNullOrEmpty(),
                    assigneeId = o.text("assignee_id")?.takeIf { it.isNotEmpty() },
                    hasReminder = id in reminded,
                ),
            )
            if (tasks.size >= MAX_TASKS) break
        }
        // De projecten waar deze gebruiker alleen lezer is (rol "viewer"): daar kan hij niets afvinken. Een server zonder "members"
        // in het antwoord: geen enkel project telt als alleen lezen (de server weigert het afvinken dan zelf, en de wachtrij ruimt het op).
        val readOnly = (root.list("members") ?: emptyList()).mapNotNullTo(HashSet()) { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNullTo null
            if (o.flag("is_deleted") || o.text("user_id") != accountId || o.text("role") != "viewer") null else o.text("project_id")
        }
        val projects = rawProjects.mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            if (o.flag("is_deleted")) return@mapNotNull null
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            WidgetProject(id, SyncParser.cleanTitle(o.text("name")), o.text("parent_id")?.takeIf { Ids.isSafeId(it) }, o.flag("is_archived"), o.text("order_key") ?: "", id in readOnly)
        }
        val sections = (root.list("sections") ?: emptyList()).mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            if (o.flag("is_deleted")) return@mapNotNull null
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            val projectId = o.text("project_id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            WidgetSection(id, projectId, SyncParser.cleanTitle(o.text("name")), o.flag("is_archived"), o.text("order_key") ?: "")
        }
        val labels = (root.list("labels") ?: emptyList()).mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            if (o.flag("is_deleted")) return@mapNotNull null
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            WidgetLabel(id, SyncParser.cleanTitle(o.text("name")))
        }
        // de notities (een server zonder notities stuurt de lijst niet mee: dan geen notities)
        val notes = WidgetNotes.parse(root.list("notes"), accountId)
        // de opgeslagen filters (een server die ze niet meestuurt: geen filters) en de mensen voor "toegewezen aan: naam"
        val filters = (root.list("filters") ?: emptyList()).mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            if (o.flag("is_deleted")) return@mapNotNull null
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            val query = o.text("query")?.takeIf { it.length <= FilterLang.MAX_QUERY_LENGTH } ?: return@mapNotNull null
            WidgetFilter(id, SyncParser.cleanTitle(o.text("name")), query, o.text("order_key") ?: "")
        }.sortedWith(compareBy({ it.orderKey }, { it.id })).take(MAX_FILTERS)
        val users = (root.list("users") ?: emptyList()).mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            WidgetUser(id, o.text("name") ?: "", o.text("username") ?: "")
        }.take(MAX_USERS)
        return WidgetSnapshot(accountId, me.text("inbox_project_id")?.takeIf { Ids.isSafeId(it) }, tasks, projects, sections, labels, notes, filters, users)
    }
}

/** Bewaart [WidgetSnapshot] als JSON-tekst. Onleesbare tekst geeft null in plaats van een fout. */
object WidgetCodec {
    private const val VERSION = 1L

    fun encode(s: WidgetSnapshot): String = Json.stringify(
        mapOf(
            "v" to VERSION,
            "account" to s.accountId,
            "inbox" to s.inboxId,
            "tasks" to s.tasks.map {
                mapOf(
                    "id" to it.id, "project" to it.projectId, "section" to it.sectionId, "parent" to it.parentId, "content" to it.content,
                    "due" to it.due, "recurring" to it.recurring, "priority" to it.priority.toLong(), "labels" to it.labelIds, "order" to it.orderKey,
                    "search" to it.search, "deadline" to it.deadline, "assignee" to it.assigneeId, "reminder" to it.hasReminder,
                )
            },
            "projects" to s.projects.map { mapOf("id" to it.id, "name" to it.name, "parent" to it.parentId, "archived" to it.archived, "order" to it.orderKey, "readOnly" to it.readOnly) },
            "sections" to s.sections.map { mapOf("id" to it.id, "project" to it.projectId, "name" to it.name, "archived" to it.archived, "order" to it.orderKey) },
            "labels" to s.labels.map { mapOf("id" to it.id, "name" to it.name) },
            "notes" to s.notes.map {
                mapOf(
                    "id" to it.id, "title" to it.title, "excerpt" to it.excerpt, "background" to it.background, "pinned" to it.pinned,
                    "updated" to it.updatedAt, "done" to it.done.toLong(), "total" to it.total.toLong(), "shared" to it.shared,
                )
            },
            "filters" to s.filters.map { mapOf("id" to it.id, "name" to it.name, "query" to it.query, "order" to it.orderKey) },
            "users" to s.users.map { mapOf("id" to it.id, "name" to it.name, "username" to it.username) },
        ),
    )

    fun decode(text: String?): WidgetSnapshot? {
        val root = Json.parseObject(text) ?: return null
        if (root.whole("v") != VERSION) return null
        val account = root.text("account")?.takeIf { Ids.isSafeId(it) } ?: return null
        fun objects(key: String) = root.list(key)?.mapNotNull { Json.asObject(it) } ?: emptyList()
        val tasks = objects("tasks").mapNotNull { o ->
            WidgetTask(
                id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null,
                projectId = o.text("project")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null,
                sectionId = o.text("section"), parentId = o.text("parent"), content = o.text("content") ?: "", due = o.text("due"),
                recurring = o.flag("recurring"), priority = o.whole("priority")?.toInt()?.takeIf { it in 1..4 } ?: 4,
                labelIds = o.list("labels")?.mapNotNull { it as? String } ?: emptyList(), orderKey = o.text("order") ?: "",
                // bewaard door een oudere versie: zonder deze velden (tot de volgende verversing vindt een filter dan minder)
                search = o.text("search") ?: "", deadline = o.flag("deadline"), assigneeId = o.text("assignee"), hasReminder = o.flag("reminder"),
            )
        }
        val projects = objects("projects").mapNotNull { o ->
            WidgetProject(o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null, o.text("name") ?: "", o.text("parent"), o.flag("archived"), o.text("order") ?: "", o.flag("readOnly"))
        }
        val sections = objects("sections").mapNotNull { o ->
            WidgetSection(
                o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null,
                o.text("project")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null,
                o.text("name") ?: "", o.flag("archived"), o.text("order") ?: "",
            )
        }
        val labels = objects("labels").mapNotNull { o -> WidgetLabel(o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null, o.text("name") ?: "") }
        // bewaard door een oudere versie: zonder "notes", dan geen notities (tot de volgende verversing)
        val notes = objects("notes").mapNotNull { o ->
            WidgetNote(
                id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null,
                title = o.text("title") ?: "", excerpt = o.text("excerpt") ?: "", background = o.text("background")?.takeIf { it in WidgetNotes.BACKGROUNDS },
                pinned = o.flag("pinned"), updatedAt = o.text("updated") ?: "", done = o.whole("done")?.toInt() ?: 0, total = o.whole("total")?.toInt() ?: 0,
                shared = o.flag("shared"),
            )
        }
        val filters = objects("filters").mapNotNull { o ->
            WidgetFilter(o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null, o.text("name") ?: "", o.text("query") ?: return@mapNotNull null, o.text("order") ?: "")
        }
        val users = objects("users").mapNotNull { o -> WidgetUser(o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null, o.text("name") ?: "", o.text("username") ?: "") }
        return WidgetSnapshot(account, root.text("inbox"), tasks, projects, sections, labels, notes, filters, users)
    }
}

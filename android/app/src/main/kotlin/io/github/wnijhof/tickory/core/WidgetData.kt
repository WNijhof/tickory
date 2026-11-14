package io.github.wnijhof.tickory.core

/** Een open taak zoals de widgets die nodig hebben. [due] is de datum zoals de server die geeft ("2026-11-13" of "2026-11-13T14:00"). */
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

/**
 * Wat de widgets van de gegevens van de gebruiker weten: de open taken, de projecten, de secties en de labels van de
 * laatste geslaagde verversing. Alleen wat de server aan deze gebruiker liet zien (gedeelde projecten: alleen die waar
 * hij lid van is); de server stuurt niets anders.
 *
 * @property accountId het id van de gebruiker van wie dit is; wisselt dat, dan gaat alles weg (zie WidgetStore)
 * @property inboxId het project dat de Inbox van deze gebruiker is
 */
data class WidgetSnapshot(
    val accountId: String,
    val inboxId: String?,
    val tasks: List<WidgetTask>,
    val projects: List<WidgetProject>,
    val sections: List<WidgetSection>,
    val labels: List<WidgetLabel>,
) {
    fun project(id: String): WidgetProject? = projects.firstOrNull { it.id == id }
}

/** Leest het antwoord van de server (`POST /api/v1/sync` met taken, projecten, secties, labels en leden) naar [WidgetSnapshot]. */
object WidgetParser {
    /** Meer open taken bewaren we niet voor de widgets: een lijst op een scherm van een telefoon is al lang ingekort. */
    const val MAX_TASKS = 5000

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
        for (entry in rawTasks) {
            val o = Json.asObject(entry) ?: continue
            if (o.flag("is_deleted") || o.flag("checked")) continue
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: continue
            val projectId = o.text("project_id")?.takeIf { Ids.isSafeId(it) } ?: continue
            val due = o.obj("due")
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
        return WidgetSnapshot(accountId, me.text("inbox_project_id")?.takeIf { Ids.isSafeId(it) }, tasks, projects, sections, labels)
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
                )
            },
            "projects" to s.projects.map { mapOf("id" to it.id, "name" to it.name, "parent" to it.parentId, "archived" to it.archived, "order" to it.orderKey, "readOnly" to it.readOnly) },
            "sections" to s.sections.map { mapOf("id" to it.id, "project" to it.projectId, "name" to it.name, "archived" to it.archived, "order" to it.orderKey) },
            "labels" to s.labels.map { mapOf("id" to it.id, "name" to it.name) },
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
        return WidgetSnapshot(account, root.text("inbox"), tasks, projects, sections, labels)
    }
}

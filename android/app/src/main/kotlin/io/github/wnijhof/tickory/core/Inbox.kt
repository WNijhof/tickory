package io.github.wnijhof.tickory.core

import java.time.Instant

/**
 * Meldingen bij samenwerken (iemand wees je een taak toe, reageerde, noemde je, vinkte jouw taak af of voegde je toe aan een
 * project) als melding op het toestel. Zonder Google-diensten en zonder pushdienst: de app haalt bij elke verversing de meldingen
 * op die de server voor de gebruiker heeft (`notifications`, zie SPEC.md) en toont de nieuwe ongelezen zelf. Dit bestand is de
 * logica zonder Android: het antwoord lezen ([InboxParser]) en beslissen wat er getoond en weggehaald wordt ([InboxPlan]).
 */

/** Eén melding zoals de server hem stuurt; titel, project en tekst komen uit de rest van hetzelfde antwoord. */
data class InboxItem(
    val id: String,
    val kind: String,
    val actor: String,
    val title: String,
    val project: String?,
    val text: String?,
    val taskId: String?,
    val projectId: String?,
    val isRead: Boolean,
    val createdAtMs: Long,
)

/**
 * @property accountId de gebruiker van wie dit is
 * @property items de meldingen die de gebruiker nu mag zien, over iets wat er nog is
 * @property push welke soorten als melding op het toestel mogen komen (`settings.notify_push`, met de standaard)
 */
data class InboxSnapshot(val accountId: String, val items: List<InboxItem>, val push: Map<String, Boolean>)

object InboxParser {
    /** De standaard: alles behalve "afgevinkt" (gelijk aan DEFAULT_PUSH in shared/notifications.js). */
    val DEFAULT_PUSH = mapOf("assigned" to true, "comment" to true, "mention" to true, "completed" to false, "shared" to true)
    private const val MAX_TEXT = 200

    /**
     * Leest de meldingen uit een sync-antwoord, of null als het antwoord ze niet heeft (een oudere server) of onbruikbaar is.
     * Een melding over een taak, project of opmerking die niet in het antwoord staat, slaan we over: die is weg of niet (meer)
     * voor deze gebruiker.
     */
    fun parse(body: String?): InboxSnapshot? {
        val root = Json.parseObject(body) ?: return null
        val accountId = root.obj("me")?.text("id")?.takeIf { Ids.isSafeId(it) } ?: return null
        val raw = root.list("notifications") ?: return null
        val names = HashMap<String, String>()
        for (u in root.list("users") ?: emptyList()) {
            val o = Json.asObject(u) ?: continue
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: continue
            names[id] = SyncParser.cleanTitle(o.text("name"))
        }
        val tasks = HashMap<String, Pair<String, String>>() // id -> (titel, project-id)
        for (t in root.list("tasks") ?: emptyList()) {
            val o = Json.asObject(t) ?: continue
            if (o.flag("is_deleted")) continue
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: continue
            val project = o.text("project_id")?.takeIf { Ids.isSafeId(it) } ?: continue
            tasks[id] = SyncParser.cleanTitle(o.text("content")) to project
        }
        val projects = HashMap<String, String>()
        for (p in root.list("projects") ?: emptyList()) {
            val o = Json.asObject(p) ?: continue
            if (o.flag("is_deleted")) continue
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: continue
            projects[id] = SyncParser.cleanTitle(o.text("name"))
        }
        // De opmerkingen zijn optioneel: zonder komt er geen tekst in de melding.
        val rawComments = root.list("comments")
        val comments = HashMap<String, String>()
        for (c in rawComments ?: emptyList()) {
            val o = Json.asObject(c) ?: continue
            if (o.flag("is_deleted")) continue
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: continue
            comments[id] = excerpt(o.text("content"))
        }
        val settings = root.list("settings")?.firstNotNullOfOrNull { Json.asObject(it)?.takeIf { s -> s.text("owner_id") == accountId } }
        val push = HashMap(DEFAULT_PUSH)
        settings?.obj("notify_push")?.forEach { (k, v) -> if (k in DEFAULT_PUSH && v is Boolean) push[k] = v }

        val items = raw.mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            if (o.flag("is_deleted")) return@mapNotNull null
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            if (o.text("owner_id") != accountId) return@mapNotNull null
            val taskId = o.text("task_id")?.takeIf { Ids.isSafeId(it) }
            val projectId = o.text("project_id")?.takeIf { Ids.isSafeId(it) }
            val commentId = o.text("comment_id")?.takeIf { Ids.isSafeId(it) }
            val title: String
            val project: String?
            if (taskId != null) {
                val (content, inProject) = tasks[taskId] ?: return@mapNotNull null
                title = content
                project = projects[inProject] ?: return@mapNotNull null
            } else {
                title = projects[projectId ?: return@mapNotNull null] ?: return@mapNotNull null
                project = null
            }
            val text = when {
                commentId == null || rawComments == null -> null
                else -> comments[commentId] ?: return@mapNotNull null // de opmerking is weg
            }
            val created = try {
                Instant.parse(o.text("created_at") ?: "").toEpochMilli()
            } catch (_: RuntimeException) {
                return@mapNotNull null
            }
            InboxItem(
                id = id, kind = o.text("kind") ?: "", actor = names[o.text("actor_id")] ?: "", title = title, project = project, text = text,
                taskId = taskId, projectId = if (taskId == null) projectId else null, isRead = o.flag("is_read"), createdAtMs = created,
            )
        }
        return InboxSnapshot(accountId, items, push)
    }

    /** Het begin van een opmerking op één regel. */
    private fun excerpt(content: String?): String {
        val oneLine = (content ?: "").replace(Regex("\\s+"), " ").trim()
        if (oneLine.length <= MAX_TEXT) return oneLine
        var cut = oneLine.substring(0, MAX_TEXT - 1)
        if (cut.last().isHighSurrogate()) cut = cut.dropLast(1)
        return cut.trimEnd() + "…"
    }
}

/**
 * Wat er van de meldingen al bekend is op dit toestel: van wie ([account]), welke meldingen de app al heeft gezien ([known]:
 * getoond, of bewust niet) en welke er nu als melding op het toestel staan ([shown]).
 */
data class InboxState(val account: String, val known: Set<String>, val shown: Set<String>) {
    fun encode(): String = Json.stringify(mapOf("v" to 1L, "account" to account, "known" to known.sorted(), "shown" to shown.sorted()))

    companion object {
        fun decode(text: String?): InboxState? {
            val o = Json.parseObject(text) ?: return null
            if (o.whole("v") != 1L) return null
            val account = o.text("account")?.takeIf { Ids.isSafeId(it) } ?: return null
            val ids = { key: String -> (o.list(key) ?: emptyList()).mapNotNullTo(HashSet()) { (it as? String)?.takeIf(Ids::isSafeId) } }
            return InboxState(account, ids("known"), ids("shown"))
        }
    }
}

object InboxPlan {
    /** Ouder dan dit tonen we niet meer als melding (bijvoorbeeld na een week zonder verbinding): de lijst in de app heeft ze wel. */
    const val MAX_AGE_MS = 3L * 24 * 3600 * 1000

    /** Zoveel nieuwe meldingen tegelijk hooguit; de rest staat in de lijst in de app. */
    const val MAX_AT_ONCE = 10

    data class Decision(val show: List<InboxItem>, val cancel: Set<String>, val next: InboxState)

    /**
     * Wat er na een verversing moet gebeuren.
     * - Eerste keer voor deze gebruiker (geen [state], of van een ander account): alles wat er al is telt als bekend, er komt
     *   niets in beeld (geen stapel oude meldingen na het inloggen), en wat er van een ander account nog stond, gaat weg.
     * - Daarna: een nieuwe ongelezen melding komt in beeld als de soort aan staat, hij niet te oud is en de app niet open is
     *   (dan zie je hem in de app zelf). Elke melding hooguit één keer, ook na een herstart.
     * - Een melding die in beeld staat maar inmiddels gelezen is (in de app of op een ander apparaat), of weg is, gaat weg.
     */
    fun decide(state: InboxState?, snapshot: InboxSnapshot, nowMs: Long, appVisible: Boolean): Decision {
        val ids = snapshot.items.mapTo(HashSet()) { it.id }
        if (state == null || state.account != snapshot.accountId) {
            return Decision(emptyList(), state?.shown ?: emptySet(), InboxState(snapshot.accountId, ids, emptySet()))
        }
        val byId = snapshot.items.associateBy { it.id }
        val cancel = state.shown.filterTo(HashSet()) { id -> byId[id]?.isRead != false }
        val fresh = snapshot.items.filter { it.id !in state.known && !it.isRead }.sortedBy { it.createdAtMs }
        val show = if (appVisible) {
            emptyList()
        } else {
            fresh.filter { snapshot.push[it.kind] == true && nowMs - it.createdAtMs <= MAX_AGE_MS }.takeLast(MAX_AT_ONCE)
        }
        // alles wat er nu is, is vanaf nu bekend: ook een gelezen melding die later weer op ongelezen wordt gezet, komt niet alsnog in beeld
        val known = ids
        val shown = (state.shown - cancel).filterTo(HashSet()) { it in ids }.apply { addAll(show.map { it.id }) }
        return Decision(show, cancel, InboxState(snapshot.accountId, known, shown))
    }
}

package io.github.wnijhof.tickory.core

/**
 * Wat een lijstwidget toont. De keuze wordt per widget bewaard als tekst ([key]); nieuwe soorten komen erbij zonder dat
 * bewaarde keuzes veranderen. [Filter] is een opgeslagen filter van de web-app (gelezen met [FilterLang]).
 */
sealed class WidgetSource {
    abstract val key: String

    /** Achterstallige taken en wat vandaag moet. */
    object Today : WidgetSource() {
        override val key = "today"
    }

    /** De komende veertien dagen, vanaf morgen, per dag. */
    object Upcoming : WidgetSource() {
        override val key = "upcoming"
    }

    /** De Inbox van de gebruiker (ook als het project nog niet bekend is, bijvoorbeeld net na het inloggen). */
    object Inbox : WidgetSource() {
        override val key = "inbox"
    }

    data class Project(val id: String) : WidgetSource() {
        override val key = "project:$id"
    }

    data class Filter(val id: String) : WidgetSource() {
        override val key = "filter:$id"
    }

    companion object {
        /** De bewaarde sleutel terug naar een bron, of null als de tekst niets betekent. */
        fun parse(key: String?): WidgetSource? = when {
            key == null -> null
            key == Today.key -> Today
            key == Upcoming.key -> Upcoming
            key == Inbox.key -> Inbox
            key.startsWith("project:") -> key.removePrefix("project:").takeIf { Ids.isSafeId(it) }?.let { Project(it) }
            key.startsWith("filter:") -> key.removePrefix("filter:").takeIf { Ids.isSafeId(it) }?.let { Filter(it) }
            else -> null
        }
    }
}

/** Eén regel in de keuzelijst van het configuratiescherm. */
data class WidgetChoice(val source: WidgetSource, val kind: Kind, val label: String, val depth: Int) {
    enum class Kind { TODAY, UPCOMING, INBOX, PROJECT, FILTER }
}

/** Welke keuzes het configuratiescherm toont: de vaste lijsten, de projecten van de gebruiker als boom, en de opgeslagen filters. */
object WidgetChoices {
    /**
     * Vandaag, Binnenkort, Inbox, daarna alle niet-gearchiveerde projecten (zonder de Inbox) in de volgorde van de
     * projectenboom, en tot slot de opgeslagen filters in hun eigen volgorde.
     */
    fun list(snapshot: WidgetSnapshot?): List<WidgetChoice> {
        val out = arrayListOf(
            WidgetChoice(WidgetSource.Today, WidgetChoice.Kind.TODAY, "", 0),
            WidgetChoice(WidgetSource.Upcoming, WidgetChoice.Kind.UPCOMING, "", 0),
            WidgetChoice(WidgetSource.Inbox, WidgetChoice.Kind.INBOX, "", 0),
        )
        if (snapshot == null) return out
        val visible = snapshot.projects.filter { it.id != snapshot.inboxId && !isArchived(snapshot, it.id) }
        val ids = visible.mapTo(HashSet()) { it.id }
        val children = visible.groupBy { if (it.parentId != null && it.parentId in ids) it.parentId else null }
        fun walk(parent: String?, depth: Int, seen: Set<String>) {
            for (p in (children[parent] ?: emptyList()).sortedWith(compareBy({ it.orderKey }, { it.id }))) {
                if (p.id in seen) continue
                out.add(WidgetChoice(WidgetSource.Project(p.id), WidgetChoice.Kind.PROJECT, p.name, depth))
                walk(p.id, depth + 1, seen + p.id)
            }
        }
        walk(null, 0, emptySet())
        for (f in snapshot.filters.sortedWith(compareBy({ it.orderKey }, { it.id }))) {
            out.add(WidgetChoice(WidgetSource.Filter(f.id), WidgetChoice.Kind.FILTER, f.name, 0))
        }
        return out
    }

    /** Is dit project gearchiveerd, of staat het onder een gearchiveerd project? */
    fun isArchived(snapshot: WidgetSnapshot, projectId: String): Boolean {
        var p = snapshot.project(projectId)
        var steps = 0
        while (p != null && steps++ < 1000) {
            if (p.archived) return true
            p = p.parentId?.let { snapshot.project(it) }
        }
        return false
    }
}

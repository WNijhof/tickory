package io.github.wnijhof.tickory.core

/**
 * Koppelt wat de locatiecontrole ziet (aankomst, vertrek) aan de herinneringen op een plek. Zuiver: geen Android.
 *
 * Een herinnering op een plek hoort bij een taak en een plaats. Ze gaat af bij het juiste soort gebeurtenis voor die
 * plaats, zolang de taak bestaat en niet is afgevinkt. Elke gebeurtenis is één keer; de volgende aankomst of het volgende
 * vertrek is een nieuwe.
 */
object GeoReminders {
    const val TYPE = "location"
    const val ENTER = "enter"
    const val LEAVE = "leave"

    /** De open locatieherinneringen: niet verwijderd, met een bekende taak die niet is afgevinkt, en een bekende plaats. */
    fun active(snapshot: SyncSnapshot): List<ReminderInfo> {
        val tasks = HashMap<String, TaskInfo>()
        for (t in snapshot.tasks) tasks[t.id] = t
        val places = snapshot.places.filter { !it.deleted }.mapTo(HashSet()) { it.id }
        return snapshot.reminders.filter { r ->
            val task = tasks[r.taskId]
            !r.deleted && r.type == TYPE && r.placeId in places && (r.trigger == ENTER || r.trigger == LEAVE) &&
                task != null && !task.deleted && !task.checked
        }
    }

    /** De plaatsen waar nu op gelet moet worden. */
    fun watchedPlaces(snapshot: SyncSnapshot): List<PlaceInfo> {
        val ids = active(snapshot).mapTo(HashSet()) { it.placeId }
        return snapshot.places.filter { !it.deleted && it.id in ids }.distinctBy { it.id }
    }

    /** Wat er nu af moet gaan voor deze gebeurtenissen: hooguit één melding per herinnering. */
    fun due(events: List<GeoEvent>, snapshot: SyncSnapshot): List<PlannedReminder> {
        if (events.isEmpty()) return emptyList()
        val tasks = HashMap<String, TaskInfo>()
        for (t in snapshot.tasks) tasks[t.id] = t
        val places = snapshot.places.associateBy { it.id }
        val out = ArrayList<PlannedReminder>()
        val seen = HashSet<String>()
        for (event in events) {
            val place = places[event.placeId] ?: continue
            val wanted = if (event.kind == GeoKind.ENTER) ENTER else LEAVE
            for (r in active(snapshot)) {
                if (r.placeId != event.placeId || r.trigger != wanted || !seen.add(r.id)) continue
                val task = tasks[r.taskId] ?: continue
                out.add(PlannedReminder(r.id, task.id, task.content, event.atMs, task.due, place = place.name, trigger = wanted))
            }
        }
        return out
    }
}

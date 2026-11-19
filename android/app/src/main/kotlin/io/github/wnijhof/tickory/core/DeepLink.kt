package io.github.wnijhof.tickory.core

/**
 * Waar de app de web-app naartoe stuurt als je op een melding of een widget tikt: het deel van het adres achter de #.
 * `task=<id>` opent een taak, `notification=<id>` een melding bij samenwerken, `share=<base64url>` een gedeelde tekst (zie ShareLink), `add` het venster Taak toevoegen (`add=today` met vandaag als datum, `add=<project-id>` in
 * dat project). Alleen veilige tekens komen erin: het fragment gaat in een stukje JavaScript en een webadres.
 */
object DeepLink {
    const val EXTRA_ADD = "io.github.wnijhof.tickory.extra.ADD"

    /** Een vaste plek om te openen, vanuit een snelkoppeling onder het app-icoon (AppShortcuts): alleen de waarden hieronder. */
    const val EXTRA_VIEW = "io.github.wnijhof.tickory.extra.VIEW"
    const val VIEW_TODAY = "today"
    const val VIEW_UPCOMING = "upcoming"
    const val VIEW_INBOX = "inbox"
    const val VIEW_NOTES = "notes"
    const val VIEW_PRODUCTIVITY = "productivity"
    const val VIEW_NEW_NOTE = "new-note"

    /**
     * Een taak die in het kleine venster "Taak toevoegen" is ingetypt en in de app verder moet ("Openen in de app", of een tik
     * op de melding "Niet toegevoegd"): de tekst, en zo nodig het project en de dag. Gaat als `share=` naar de web-app (ShareLink.draftFragment).
     */
    const val EXTRA_DRAFT_TEXT = "io.github.wnijhof.tickory.extra.DRAFT_TEXT"
    const val EXTRA_DRAFT_PROJECT = "io.github.wnijhof.tickory.extra.DRAFT_PROJECT"
    const val EXTRA_DRAFT_DUE = "io.github.wnijhof.tickory.extra.DRAFT_DUE"

    private val SAFE = Regex("^[A-Za-z0-9_=-]{1,100000}$")

    /** Mag dit fragment in een webadres en in een stukje JavaScript? Alleen letters, cijfers, "-", "_" en "=" (base64url past daarin). */
    fun isSafe(fragment: String?): Boolean = fragment != null && SAFE.matches(fragment)

    /** Een taak opent met `task=<id>`; de "taak" van een herinnering op een notitie (note_<id>, zie NoteReminders) met `note=<id>`. */
    fun task(id: String?): String? = id?.takeIf(Ids::isSafeId)?.let {
        if (NoteReminders.isNote(it)) "note=${NoteReminders.noteId(it)}" else "task=$it"
    }

    /** Een melding bij samenwerken: de web-app zet hem op gelezen en opent de taak of het project (zie client/ui/inbox.js). */
    fun notification(id: String?): String? = id?.takeIf(Ids::isSafeId)?.let { "notification=$it" }

    /** @param target null of leeg voor "waar je nu bent", "today", of een project-id; iets anders wordt ook "waar je nu bent" */
    fun add(target: String?): String = when {
        target == null || target.isEmpty() -> "add"
        target == "today" -> "add=today"
        Ids.isSafeId(target) -> "add=$target"
        else -> "add"
    }

    /** `view=today` (of upcoming, inbox, notes) opent dat overzicht, `note=new` een nieuwe notitie; een andere waarde niets. */
    fun view(target: String?): String? = when (target) {
        VIEW_TODAY, VIEW_UPCOMING, VIEW_INBOX, VIEW_NOTES, VIEW_PRODUCTIVITY -> "view=$target"
        VIEW_NEW_NOTE -> "note=new"
        else -> null
    }

    /** Het fragment bij de gegevens van een intentie: een taak gaat voor, anders Taak toevoegen als daar om gevraagd is. */
    fun fromExtras(taskId: String?, hasAdd: Boolean, addTarget: String?): String? = task(taskId) ?: if (hasAdd) add(addTarget) else null
}

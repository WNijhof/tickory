package io.github.wnijhof.tickory.core

/**
 * Waar de app de web-app naartoe stuurt als je op een melding of een widget tikt: het deel van het adres achter de #.
 * `task=<id>` opent een taak, `notification=<id>` een melding bij samenwerken, `share=<base64url>` een gedeelde tekst (zie ShareLink), `add` het venster Taak toevoegen (`add=today` met vandaag als datum, `add=<project-id>` in
 * dat project). Alleen veilige tekens komen erin: het fragment gaat in een stukje JavaScript en een webadres.
 */
object DeepLink {
    const val EXTRA_ADD = "io.github.wnijhof.tickory.extra.ADD"

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

    /** Het fragment bij de gegevens van een intentie: een taak gaat voor, anders Taak toevoegen als daar om gevraagd is. */
    fun fromExtras(taskId: String?, hasAdd: Boolean, addTarget: String?): String? = task(taskId) ?: if (hasAdd) add(addTarget) else null
}

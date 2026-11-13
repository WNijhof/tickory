package io.github.wnijhof.tickory.core

/**
 * Waar de app de web-app naartoe stuurt als je op een melding of een widget tikt: het deel van het adres achter de #.
 * `task=<id>` opent een taak, `add` het venster Taak toevoegen (`add=today` met vandaag als datum, `add=<project-id>` in
 * dat project). Alleen veilige tekens komen erin: het fragment gaat in een stukje JavaScript en een webadres.
 */
object DeepLink {
    const val EXTRA_ADD = "io.github.wnijhof.tickory.extra.ADD"

    fun task(id: String?): String? = id?.takeIf(Ids::isSafeId)?.let { "task=$it" }

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

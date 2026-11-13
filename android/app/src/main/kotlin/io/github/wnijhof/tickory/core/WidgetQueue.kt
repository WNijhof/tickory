package io.github.wnijhof.tickory.core

import java.security.SecureRandom

/**
 * Een taak die in een widget is afgevinkt en nog bij de server moet aankomen.
 *
 * @property uuid het commando-uuid: bij opnieuw proberen altijd hetzelfde, zodat de server het hooguit één keer uitvoert
 * @property ifDue bij een terugkerende taak: de datum die de gebruiker zag. Heeft de taak intussen een andere datum
 *   (op een ander apparaat of in de web-app al afgevinkt), dan doet de server niets, en schuift hij dus niet twee keer door.
 * @property accountId van wie de taak is; wat niet van de aangemelde gebruiker is, wordt nooit verstuurd
 */
data class QueuedComplete(
    val taskId: String,
    val uuid: String,
    val ifDue: String?,
    val accountId: String,
    val queuedAtMs: Long,
)

/** De regels van de wachtrij voor afvinken vanuit een widget, als zuivere functies (de opslag staat in WidgetStore). */
object WidgetQueue {
    /** Zo lang proberen we het. Daarna komt de taak gewoon terug in de widget, zoals de server hem heeft. */
    const val RETENTION_MS: Long = 3L * 24 * 60 * 60 * 1000

    /** Hooguit zoveel tegelijk in één verzoek (de server staat er 100 per verzoek toe). */
    const val BATCH = 50

    private val random = SecureRandom()

    /** Een nieuw uuid voor een afvinkactie: 10 + 24 tekens uit [a-z0-9-], binnen wat de server vraagt (8 tot 64 uit [A-Za-z0-9_-]). */
    fun newUuid(nextByte: () -> Int = { random.nextInt(256) }): String {
        val sb = StringBuilder("tickory-w-")
        repeat(12) {
            val b = nextByte() and 0xff
            sb.append("0123456789abcdef"[b ushr 4]).append("0123456789abcdef"[b and 0x0f])
        }
        return sb.toString()
    }

    /**
     * Zet een afvinkactie in de rij, tenzij er voor deze taak al een staat (dubbel tikken blijft één actie).
     * @return de nieuwe rij, en of er iets bij kwam
     */
    fun enqueue(items: List<QueuedComplete>, item: QueuedComplete): Pair<List<QueuedComplete>, Boolean> =
        if (items.any { it.taskId == item.taskId && it.accountId == item.accountId }) items to false else (items + item) to true

    /** Afgehandeld (gelukt of definitief geweigerd): weg uit de rij. */
    fun settle(items: List<QueuedComplete>, uuids: Set<String>): List<QueuedComplete> = items.filter { it.uuid !in uuids }

    /** De server kent het argument `if_due` niet (een oudere server): dezelfde actie opnieuw, zonder, en met een nieuw uuid. */
    fun withoutGuard(items: List<QueuedComplete>, uuid: String, newUuid: String): List<QueuedComplete> =
        items.map { if (it.uuid == uuid) it.copy(uuid = newUuid, ifDue = null) else it }

    /** Wat te lang wacht. */
    fun expired(items: List<QueuedComplete>, nowMs: Long): List<QueuedComplete> = items.filter { it.queuedAtMs < nowMs - RETENTION_MS }

    /** Alleen wat van deze gebruiker is. */
    fun forAccount(items: List<QueuedComplete>, accountId: String?): List<QueuedComplete> =
        if (accountId == null) emptyList() else items.filter { it.accountId == accountId }

    fun encode(items: List<QueuedComplete>): String = Json.stringify(
        mapOf(
            "v" to 1L,
            "items" to items.map { mapOf("task" to it.taskId, "uuid" to it.uuid, "ifDue" to it.ifDue, "account" to it.accountId, "at" to it.queuedAtMs) },
        ),
    )

    fun decode(text: String?): List<QueuedComplete> {
        val root = Json.parseObject(text) ?: return emptyList()
        if (root.whole("v") != 1L) return emptyList()
        return (root.list("items") ?: emptyList()).mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            QueuedComplete(
                taskId = o.text("task")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null,
                uuid = o.text("uuid")?.takeIf { Regex("^[A-Za-z0-9_-]{8,64}$").matches(it) } ?: return@mapNotNull null,
                ifDue = o.text("ifDue"),
                accountId = o.text("account")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null,
                queuedAtMs = o.whole("at") ?: return@mapNotNull null,
            )
        }
    }
}

package io.github.wnijhof.tickory.core

import java.security.SecureRandom

/**
 * Een notitie die in het kleine venster "Notitie toevoegen" is ingetypt en nog bij de server moet aankomen (als commando `note_add`,
 * gewone synchronisatie; er is geen apart eindpunt nodig, een notitie heeft geen herkenning van datum of project).
 *
 * @property uuid het commando-uuid: bij opnieuw proberen altijd hetzelfde, zodat de server het hooguit één keer uitvoert
 * @property noteId het id van de nieuwe notitie (door het toestel bedacht, zoals de web-app dat ook doet)
 * @property accountId van wie de notitie is; null als dat bij het intypen nog niet vaststond (net ingelogd)
 * @property session vingerafdruk van de aanmelding bij het intypen (geen token): alleen voor een notitie zonder [accountId]
 */
data class QueuedNote(
    val uuid: String,
    val noteId: String,
    val title: String,
    val content: String,
    val pinned: Boolean,
    val accountId: String?,
    val session: String,
    val queuedAtMs: Long,
)

/** De regels van de wachtrij van het kleine venster Notitie toevoegen, als zuivere functies (de opslag staat in QuickNoteStore). */
object QuickNoteQueue {
    /** Zo lang proberen we het; daarna komt er een melding met de tekst, zodat er niets stil verloren gaat. */
    const val RETENTION_MS: Long = 14L * 24 * 60 * 60 * 1000

    /** Meer wachtende notities nemen we niet aan: dan klopt er iets niet (al dagen geen verbinding), en de app zegt dat. */
    const val MAX_ITEMS = 100

    /** Hooguit zoveel in één verzoek. */
    const val BATCH = 25

    /** De grenzen van de server (SPEC, entiteit `note`). */
    const val MAX_TITLE = 200
    const val MAX_CONTENT = 100_000

    private val random = SecureRandom()
    private const val HEX = "0123456789abcdef"
    private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

    /** Een nieuw commando-uuid: "tickory-n-" en 24 tekens uit [0-9a-f] (de server vraagt 8 tot 64 uit [A-Za-z0-9_-]). */
    fun newUuid(nextByte: () -> Int = { random.nextInt(256) }): String {
        val sb = StringBuilder("tickory-n-")
        repeat(12) {
            val b = nextByte() and 0xff
            sb.append(HEX[b ushr 4]).append(HEX[b and 0x0f])
        }
        return sb.toString()
    }

    /** Een nieuw notitie-id: 16 tekens uit [a-z0-9] (de server vraagt 8 tot 40 uit [A-Za-z0-9_-]). */
    fun newNoteId(nextByte: () -> Int = { random.nextInt(256) }): String {
        val sb = StringBuilder()
        repeat(16) { sb.append(ALPHABET[(nextByte() and 0xff) % ALPHABET.length]) }
        return sb.toString()
    }

    /** Zet een notitie achteraan, tenzij de rij vol is of het uuid er al in staat. @return de nieuwe rij en of er iets bij kwam */
    fun enqueue(items: List<QueuedNote>, item: QueuedNote): Pair<List<QueuedNote>, Boolean> = when {
        items.size >= MAX_ITEMS || items.any { it.uuid == item.uuid } -> items to false
        else -> (items + item) to true
    }

    /** Afgehandeld (gelukt, geweigerd of vervallen): weg uit de rij. */
    fun settle(items: List<QueuedNote>, uuids: Set<String>): List<QueuedNote> = items.filter { it.uuid !in uuids }

    /** Wat te lang wacht. */
    fun expired(items: List<QueuedNote>, nowMs: Long): List<QueuedNote> = items.filter { it.queuedAtMs < nowMs - RETENTION_MS }

    /**
     * Wat onder deze aanmelding verstuurd mag worden: van deze gebruiker, of (zonder bekende gebruiker bij het intypen) onder
     * dezelfde aanmelding. Wat van een ander is, wordt nooit verstuurd.
     */
    fun sendable(items: List<QueuedNote>, accountId: String?, session: String?): List<QueuedNote> =
        items.filter { (it.accountId != null && it.accountId == accountId) || (it.accountId == null && session != null && it.session == session) }

    /** Wat niet onder deze aanmelding verstuurd mag worden (een andere gebruiker, of een vorige aanmelding zonder bekende gebruiker). */
    fun foreign(items: List<QueuedNote>, accountId: String?, session: String?): List<QueuedNote> =
        items - sendable(items, accountId, session).toSet()

    /** De argumenten van het commando `note_add`: alleen wat is ingevuld. */
    fun args(item: QueuedNote): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        out["id"] = item.noteId
        if (item.title.isNotEmpty()) out["title"] = item.title
        if (item.content.isNotEmpty()) out["content"] = item.content
        if (item.pinned) out["is_pinned"] = true
        return out
    }

    /** Een lege notitie (geen titel en geen tekst) wordt niet toegevoegd. */
    fun isEmpty(title: String, content: String): Boolean = title.isBlank() && content.isBlank()

    fun encode(items: List<QueuedNote>): String = Json.stringify(
        mapOf(
            "v" to 1L,
            "items" to items.map {
                mapOf(
                    "uuid" to it.uuid, "note" to it.noteId, "title" to it.title, "content" to it.content, "pinned" to it.pinned,
                    "account" to it.accountId, "session" to it.session, "at" to it.queuedAtMs,
                )
            },
        ),
    )

    fun decode(text: String?): List<QueuedNote> {
        val root = Json.parseObject(text) ?: return emptyList()
        if (root.whole("v") != 1L) return emptyList()
        return root.list("items")?.mapNotNull { raw ->
            val o = Json.asObject(raw) ?: return@mapNotNull null
            val uuid = o.text("uuid")?.takeIf(UUID::matches) ?: return@mapNotNull null
            val note = o.text("note")?.takeIf(Ids::isSafeId) ?: return@mapNotNull null
            QueuedNote(
                uuid, note, o.text("title").orEmpty().take(MAX_TITLE), o.text("content").orEmpty().take(MAX_CONTENT), o.flag("pinned"),
                o.text("account")?.takeIf(Ids::isSafeId), o.text("session").orEmpty(), o.whole("at") ?: return@mapNotNull null,
            )
        } ?: emptyList()
    }

    private val UUID = Regex("^[A-Za-z0-9_-]{8,64}$")
}

package io.github.wnijhof.tickory.core

import java.security.MessageDigest

object Ids {
    private val SAFE = Regex("^[A-Za-z0-9_-]{1,64}$")

    /**
     * Id's van de server bestaan uit letters, cijfers, "_" en "-". Alleen zulke id's gebruiken we: ze komen terecht in
     * een webadres (#task=…), in een stukje JavaScript en in de naam van een alarm, en mogen daar niets kunnen breken.
     */
    fun isSafeId(value: String?): Boolean = value != null && SAFE.matches(value)

    /**
     * Het uuid voor "voltooi deze taak vanuit deze melding". Bewust niet willekeurig maar afgeleid van de herinnering,
     * de taak en het tijdstip: opnieuw proberen, twee keer tikken en dezelfde melding op een tweede toestel geven
     * allemaal hetzelfde uuid, en de server voert een uuid maar één keer uit. Een terugkerende taak schuift daardoor
     * nooit twee keer door. 53 tekens uit [a-z0-9-]; de server vraagt 8 tot 64 tekens uit [A-Za-z0-9_-].
     */
    fun completeUuid(reminderId: String, taskId: String, triggerAtMs: Long): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("$reminderId|$taskId|$triggerAtMs".toByteArray(Charsets.UTF_8))
        val hex = StringBuilder("tickory-done-")
        for (i in 0 until 20) { // 20 bytes = 40 hexadecimale tekens; zonder String.format, dat volgt de taal van het toestel
            val b = digest[i].toInt() and 0xff
            hex.append("0123456789abcdef"[b ushr 4]).append("0123456789abcdef"[b and 0x0f])
        }
        return hex.toString()
    }
}

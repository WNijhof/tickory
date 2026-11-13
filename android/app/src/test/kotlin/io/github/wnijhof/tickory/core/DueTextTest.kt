package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class DueTextTest {
    private val amsterdam = ZoneId.of("Europe/Amsterdam")

    /** Vrijdag 13 november 2026, 10:00 in Amsterdam. */
    private val now = Instant.parse("2026-11-13T09:00:00Z").toEpochMilli()

    private fun nl(due: String?) = DueText.format(due, now, amsterdam, Lang.NL)
    private fun en(due: String?, use24Hour: Boolean = true) = DueText.format(due, now, amsterdam, Lang.EN, use24Hour)

    @Test
    fun `vandaag, morgen en gisteren`() {
        assertEquals("vandaag 14:00", nl("2026-11-13T14:00"))
        assertEquals("vandaag 14:00", nl("2026-11-13T14:00:30"))
        assertEquals("vandaag", nl("2026-11-13"))
        assertEquals("morgen 09:05", nl("2026-11-14T09:05"))
        assertEquals("morgen", nl("2026-11-14"))
        assertEquals("gisteren 23:59", nl("2026-11-12T23:59"))
        assertEquals("vandaag 00:00", nl("2026-11-13T00:00"))
    }

    @Test
    fun `verder weg - weekdag, dag en maand, en het jaar als dat anders is`() {
        assertEquals("wo 18 nov 09:30", nl("2026-11-18T09:30"))
        assertEquals("zo 15 nov", nl("2026-11-15"))
        assertEquals("wo 11 nov", nl("2026-11-11"))
        assertEquals("di 1 dec 08:00", nl("2026-12-01T08:00"))
        assertEquals("ma 4 jan 2027", nl("2027-01-04"))
        assertEquals("do 25 mrt 2027 12:00", nl("2027-03-25T12:00"))
        assertEquals("wo 31 dec 2025", nl("2025-12-31"))
    }

    @Test
    fun `alle maanden en weekdagen in het Nederlands`() {
        val months = (1..12).map { nl("2026-%02d-20".format(it))!!.split(" ")[2] }
        assertEquals(listOf("jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"), months)
        // maandag 1 juni 2026 tot en met zondag 7 juni 2026
        val days = (1..7).map { nl("2026-06-%02d".format(it))!!.split(" ")[0] }
        assertEquals(listOf("ma", "di", "wo", "do", "vr", "za", "zo"), days)
    }

    @Test
    fun `Engels`() {
        assertEquals("today 14:00", en("2026-11-13T14:00"))
        assertEquals("tomorrow", en("2026-11-14"))
        assertEquals("yesterday 09:05", en("2026-11-12T09:05"))
        assertEquals("Wed 18 Nov 09:30", en("2026-11-18T09:30"))
        assertEquals("Mon 4 Jan 2027", en("2027-01-04"))
    }

    @Test
    fun `Engels met de twaalfuursklok`() {
        assertEquals("today 2:00 PM", en("2026-11-13T14:00", use24Hour = false))
        assertEquals("today 12:05 AM", en("2026-11-13T00:05", use24Hour = false))
        assertEquals("today 12:00 PM", en("2026-11-13T12:00", use24Hour = false))
        assertEquals("tomorrow 9:30 AM", en("2026-11-14T09:30", use24Hour = false))
        assertEquals("today 11:59 PM", en("2026-11-13T23:59", use24Hour = false))
        // Nederlands blijft de 24-uursklok gebruiken, wat het toestel ook zegt
        assertEquals("vandaag 14:00", DueText.format("2026-11-13T14:00", now, amsterdam, Lang.NL, use24Hour = false))
    }

    @Test
    fun `vandaag hangt af van de tijdzone`() {
        // 23:30 UTC op de 13e is in Amsterdam al de 14e (00:30)
        val lateEvening = Instant.parse("2026-11-13T23:30:00Z").toEpochMilli()
        assertEquals("vandaag", DueText.format("2026-11-14", lateEvening, amsterdam, Lang.NL))
        assertEquals("morgen", DueText.format("2026-11-14", lateEvening, ZoneId.of("UTC"), Lang.NL))
        assertEquals("vandaag", DueText.format("2026-11-13", lateEvening, ZoneId.of("America/New_York"), Lang.NL))
    }

    @Test
    fun `geen of ongeldige datum geeft niets`() {
        for (due in listOf(null, "", "morgen", "2026-02-30", "2026-11-13T14:00Z", "13-11-2026")) assertNull("'$due'", nl(due))
        // een geldige dag met een onmogelijke tijd: de dag kunnen we nog tonen
        assertEquals("vandaag", nl("2026-11-13T25:00"))
    }

    @Test
    fun `taalkeuze - alles wat geen Engels is, is Nederlands`() {
        assertEquals(Lang.NL, Lang.of("nl"))
        assertEquals(Lang.EN, Lang.of("en"))
        assertEquals(Lang.EN, Lang.of("EN-us"))
        assertEquals(Lang.NL, Lang.of("de"))
        assertEquals(Lang.NL, Lang.of(""))
        assertEquals(Lang.NL, Lang.of(null))
    }
}

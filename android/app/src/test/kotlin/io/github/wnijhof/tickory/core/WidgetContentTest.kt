package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.WidgetFixtures.amsterdam
import io.github.wnijhof.tickory.core.WidgetFixtures.at
import io.github.wnijhof.tickory.core.WidgetFixtures.project
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/** Welke taken een widget toont, in welke volgorde, en hoe de datum erbij staat. Vrijdag 13 november 2026, 09:00 in Amsterdam. */
class WidgetContentTest {
    private val now = at("2026-11-13T09:00")

    private fun build(
        snapshot: WidgetSnapshot,
        source: WidgetSource,
        hidden: Set<String> = emptySet(),
        nowMs: Long = now,
        zone: ZoneId = amsterdam,
        lang: Lang = Lang.NL,
        maxRows: Int = WidgetContentBuilder.MAX_ROWS,
    ) = WidgetContentBuilder.build(snapshot, source, hidden, nowMs, zone, lang, true, maxRows)

    private fun items(content: WidgetContent) = content.rows.filterIsInstance<WidgetRow.Item>()
    private fun ids(content: WidgetContent) = items(content).map { it.id }

    // ---------- Vandaag ----------

    @Test
    fun `vandaag - te laat en vandaag, niet later en niet zonder datum`() {
        val s = snapshot(
            listOf(
                task("gisteren", "2026-11-12"), task("vandaag", "2026-11-13"), task("morgen", "2026-11-14"),
                task("zonder"), task("eerder", "2026-11-01T08:00"), task("later", "2026-12-01"),
            ),
        )
        val content = build(s, WidgetSource.Today)
        assertEquals(listOf("eerder", "gisteren", "vandaag"), ids(content))
        assertEquals(3, content.count)
        assertEquals(ContentKind.TODAY, content.kind)
    }

    @Test
    fun `vandaag - te laat telt op de dag, niet op de tijd`() {
        val s = snapshot(listOf(task("ochtend", "2026-11-13T07:00"), task("avond", "2026-11-13T21:00"), task("gisteren", "2026-11-12T23:59")))
        val rows = items(build(s, WidgetSource.Today))
        assertEquals(listOf("gisteren", "ochtend", "avond"), rows.map { it.id })
        assertEquals("alleen wat vóór vandaag valt is te laat", listOf(true, false, false), rows.map { it.overdue })
    }

    @Test
    fun `vandaag - volgorde zoals de web-app - tijdstip, dan prioriteit, dan eigen volgorde`() {
        val s = snapshot(
            listOf(
                task("c", "2026-11-13", priority = 4, order = "a3"),
                task("b", "2026-11-13", priority = 1, order = "a2"),
                task("a", "2026-11-13", priority = 1, order = "a1"),
                task("t", "2026-11-13T08:00", priority = 4),
                task("u", "2026-11-12", priority = 4),
            ),
        )
        // een datum zonder tijd sorteert vóór dezelfde dag met tijd (kortere tekst), zoals in selectors.js
        assertEquals(listOf("u", "a", "b", "c", "t"), ids(build(s, WidgetSource.Today)))
    }

    @Test
    fun `vandaag - de datum bij de taak - alleen de tijd voor vandaag, de dag voor wat te laat is`() {
        val s = snapshot(listOf(task("a", "2026-11-13T14:00"), task("b", "2026-11-13"), task("c", "2026-11-12"), task("d", "2026-11-11T09:30")))
        val rows = items(build(s, WidgetSource.Today)).associateBy { it.id }
        assertEquals("14:00", rows.getValue("a").due)
        assertEquals(null, rows.getValue("b").due)
        assertEquals("gisteren", rows.getValue("c").due)
        assertEquals("wo 11 nov 09:30", rows.getValue("d").due)
        val english = items(build(s, WidgetSource.Today, lang = Lang.EN)).associateBy { it.id }
        assertEquals("yesterday", english.getValue("c").due)
        assertEquals("Wed 11 Nov 09:30", english.getValue("d").due)
    }

    @Test
    fun `vandaag - zwevende datums - hetzelfde moment is in een andere tijdzone een andere dag`() {
        // 23:30 in Amsterdam op 13 november is al 14 november in Tokio, en nog 13 november in New York
        val moment = at("2026-11-13T23:30")
        val s = snapshot(listOf(task("a", "2026-11-13"), task("b", "2026-11-14")))
        assertEquals(listOf("a"), ids(build(s, WidgetSource.Today, nowMs = moment, zone = amsterdam)))
        assertEquals(listOf("a", "b"), ids(build(s, WidgetSource.Today, nowMs = moment, zone = ZoneId.of("Asia/Tokyo"))))
        assertEquals(listOf("a"), ids(build(s, WidgetSource.Today, nowMs = moment, zone = ZoneId.of("America/New_York"))))
        // een taak om 09:00 blijft 09:00 op de klok, waar je ook bent: alleen de dag eromheen verschuift
        val timed = snapshot(listOf(task("t", "2026-11-13T09:00")))
        assertEquals("09:00", items(build(timed, WidgetSource.Today, nowMs = moment, zone = amsterdam)).first().due)
        assertEquals("gisteren 09:00", items(build(timed, WidgetSource.Today, nowMs = moment, zone = ZoneId.of("Asia/Tokyo"))).first().due)
    }

    @Test
    fun `vandaag - middernacht en de zomertijd verschuiven niets`() {
        // zondag 25 oktober 2026: de klok gaat 03:00 -> 02:00 (wintertijd). Om 02:30 (twee keer) is het nog 25 oktober.
        val s = snapshot(listOf(task("a", "2026-10-25"), task("b", "2026-10-26")))
        assertEquals(listOf("a"), ids(build(s, WidgetSource.Today, nowMs = at("2026-10-25T00:05"))))
        assertEquals(listOf("a"), ids(build(s, WidgetSource.Today, nowMs = at("2026-10-25T23:59"))))
        assertEquals(listOf("a", "b"), ids(build(s, WidgetSource.Today, nowMs = at("2026-10-26T00:01"))))
    }

    @Test
    fun `vandaag - een ongeldige datum telt niet mee en breekt niets`() {
        val s = snapshot(listOf(task("kapot", "2026-13-45"), task("raar", "morgen"), task("goed", "2026-11-13")))
        assertEquals(listOf("goed"), ids(build(s, WidgetSource.Today)))
    }

    @Test
    fun `vandaag - subtaken staan er ook, het project en de labels staan in de regel`() {
        val s = snapshot(
            tasks = listOf(task("sub", "2026-11-13", parent = "ouder", project = "werk", labels = listOf("l1", "l2", "l3"))),
            projects = listOf(project("inbox-project", "Inbox"), project("werk", "Werk")),
            labels = listOf(WidgetLabel("l1", "bellen"), WidgetLabel("l2", "thuis"), WidgetLabel("l3", "later")),
        )
        assertEquals("Werk · @bellen · @thuis", items(build(s, WidgetSource.Today)).single().meta)
    }

    @Test
    fun `afgevinkte taken in de wachtrij zijn weg, en hun subtaken ook - tenzij de taak terugkeert`() {
        val s = snapshot(
            listOf(
                task("gewoon", "2026-11-13"), task("kind", "2026-11-13", parent = "gewoon"), task("kleinkind", "2026-11-13", parent = "kind"),
                task("terugkerend", "2026-11-13", recurring = true), task("kind2", "2026-11-13", parent = "terugkerend"), task("ander", "2026-11-13"),
            ),
        )
        val content = build(s, WidgetSource.Today, hidden = setOf("gewoon", "terugkerend"))
        assertEquals(listOf("ander", "kind2"), ids(content).sorted())
        assertEquals(2, content.count)
        assertEquals("een onbekend id in de wachtrij doet niets", 6, ids(build(s, WidgetSource.Today, hidden = setOf("bestaat-niet"))).size)
    }

    // ---------- Binnenkort ----------

    @Test
    fun `binnenkort - vanaf morgen veertien dagen, per dag met een kop`() {
        val s = snapshot(
            listOf(
                task("vandaag", "2026-11-13"), task("morgen", "2026-11-14T10:00"), task("morgen2", "2026-11-14"), task("over2", "2026-11-15"),
                task("dag14", "2026-11-27"), task("dag15", "2026-11-28"), task("te-laat", "2026-11-01"),
            ),
        )
        val content = build(s, WidgetSource.Upcoming)
        assertEquals(ContentKind.UPCOMING, content.kind)
        assertEquals(listOf("morgen2", "morgen", "over2", "dag14"), ids(content))
        assertEquals(listOf("Morgen", "Zo 15 nov", "Vr 27 nov"), content.rows.filterIsInstance<WidgetRow.Header>().map { it.text })
        assertEquals(4, content.count)
        assertEquals("op een dagkop staat alleen de tijd", listOf(null, "10:00"), items(content).take(2).map { it.due })
        // de volgorde van koppen en regels
        assertTrue(content.rows[0] is WidgetRow.Header && content.rows[1] is WidgetRow.Item)
    }

    @Test
    fun `binnenkort - in het Engels`() {
        val s = snapshot(listOf(task("a", "2026-11-14"), task("b", "2026-11-16T15:30")))
        val content = WidgetContentBuilder.build(s, WidgetSource.Upcoming, emptySet(), now, amsterdam, Lang.EN, false)
        assertEquals(listOf("Tomorrow", "Mon 16 Nov"), content.rows.filterIsInstance<WidgetRow.Header>().map { it.text })
        assertEquals("3:30 PM", items(content).last().due)
    }

    // ---------- project en Inbox ----------

    @Test
    fun `project - taken per sectie als boom, afgevinkte niet, gearchiveerde sectie telt als geen sectie`() {
        val s = snapshot(
            tasks = listOf(
                task("los", project = "werk", order = "a1"),
                task("kind", project = "werk", parent = "los", order = "a1"),
                task("in-sectie", project = "werk", section = "s1", order = "a1"),
                task("in-oude-sectie", project = "werk", section = "s2", order = "a2"),
                task("elders", project = "prive"),
            ),
            projects = listOf(project("inbox-project", "Inbox"), project("werk", "Werk"), project("prive", "Privé")),
            sections = listOf(WidgetSection("s1", "werk", "Deze week", false, "a1"), WidgetSection("s2", "werk", "Oud", true, "a2"), WidgetSection("s3", "werk", "Leeg", false, "a3")),
        )
        val content = build(s, WidgetSource.Project("werk"))
        assertEquals("Werk", content.projectName)
        assertEquals(listOf("los", "kind", "in-oude-sectie", "in-sectie"), ids(content))
        assertEquals("een lege sectie krijgt geen kop", listOf("Deze week"), content.rows.filterIsInstance<WidgetRow.Header>().map { it.text })
        assertEquals(listOf(0, 1, 0, 0), items(content).map { it.depth })
        assertEquals("kopje komt voor de taken van de sectie", WidgetRow.Header("Deze week"), content.rows[3])
        assertEquals(4, content.count)
    }

    @Test
    fun `project - zonder project in de regel, met de datum er helemaal bij`() {
        val s = snapshot(listOf(task("a", "2026-11-14T09:30", project = "inbox-project"), task("b", "2026-11-12", project = "inbox-project")))
        val rows = items(build(s, WidgetSource.Inbox))
        assertEquals(listOf("morgen 09:30", "gisteren"), rows.map { it.due })
        assertEquals(listOf(null, null), rows.map { it.meta })
        assertEquals(listOf(false, true), rows.map { it.overdue })
    }

    @Test
    fun `inbox - de Inbox van deze gebruiker, ook een andere dan inbox-project`() {
        val s = snapshot(
            tasks = listOf(task("a", project = "inbox-u2"), task("b", project = "inbox-project")),
            projects = listOf(project("inbox-u2", "Inbox")),
            inbox = "inbox-u2",
        )
        assertEquals(listOf("a"), ids(build(s, WidgetSource.Inbox)))
    }

    @Test
    fun `project - een project dat er niet (meer) is - verwijderd of geen lid meer - geeft geen taken`() {
        val s = snapshot(listOf(task("a", project = "weg")))
        val content = build(s, WidgetSource.Project("weg"))
        assertTrue(content.missing)
        assertEquals(0, content.count)
        assertTrue(content.rows.isEmpty())
        assertTrue(build(snapshot(inbox = null), WidgetSource.Inbox).missing)
    }

    @Test
    fun `een filter wordt herkend maar kan nog niet`() {
        val content = build(snapshot(listOf(task("a", "2026-11-13"))), WidgetSource.Filter("f1"))
        assertEquals(ContentKind.UNSUPPORTED, content.kind)
        assertTrue(content.rows.isEmpty())
    }

    @Test
    fun `lange lijsten worden ingekort zonder dat het aantal verandert, en zonder kop zonder taken`() {
        val many = (1..300).map { task("t$it", "2026-11-13", order = "a%03d".format(it)) }
        val today = build(snapshot(many), WidgetSource.Today)
        assertEquals(300, today.count)
        assertEquals(WidgetContentBuilder.MAX_ROWS, today.rows.size)

        val s = snapshot(listOf(task("x", "2026-11-14"), task("y", "2026-11-15")))
        val cut = build(s, WidgetSource.Upcoming, maxRows = 3) // kop, taak, kop: de laatste kop zou leeg zijn
        assertEquals(2, cut.rows.size)
        assertFalse(cut.rows.last() is WidgetRow.Header)
        assertEquals(2, cut.count)
    }

    // ---------- keuzelijst, bronnen, formaat ----------

    @Test
    fun `bronnen - sleutel heen en terug, onzin wordt genegeerd`() {
        for (source in listOf(WidgetSource.Today, WidgetSource.Upcoming, WidgetSource.Inbox, WidgetSource.Project("werk-1"), WidgetSource.Filter("f_1"))) {
            assertEquals(source, WidgetSource.parse(source.key))
        }
        for (bad in listOf(null, "", "project:", "project:a b", "project:<x>", "filter:", "iets", "TODAY", "project:" + "a".repeat(65))) {
            assertEquals("'$bad'", null, WidgetSource.parse(bad))
        }
    }

    @Test
    fun `keuzelijst - vaste lijsten, dan de projecten als boom zonder Inbox en zonder gearchiveerde`() {
        val s = snapshot(
            projects = listOf(
                project("inbox-project", "Inbox"), project("b", "Bravo", order = "a2"), project("a", "Alfa", order = "a1"),
                project("a1", "Alfa-sub", parent = "a"), project("z", "Oud", archived = true), project("z1", "Oud-sub", parent = "z"),
                project("wees", "Wees", parent = "bestaat-niet", order = "a3"),
            ),
        )
        val choices = WidgetChoices.list(s)
        assertEquals(listOf("today", "upcoming", "inbox", "project:a", "project:a1", "project:b", "project:wees"), choices.map { it.source.key })
        assertEquals(listOf(0, 0, 0, 0, 1, 0, 0), choices.map { it.depth })
        assertEquals(listOf("today", "upcoming", "inbox"), WidgetChoices.list(null).map { it.source.key })
    }

    @Test
    fun `keuzelijst - een ring in de projectenboom blijft niet hangen`() {
        val s = snapshot(projects = listOf(project("inbox-project", "Inbox"), project("a", parent = "b"), project("b", parent = "a")))
        assertEquals(listOf("today", "upcoming", "inbox"), WidgetChoices.list(s).map { it.source.key }) // niemand is een wortel: geen oneindige lus
        assertTrue(WidgetChoices.isArchived(s, "a").not())
    }

    @Test
    fun `formaat - klein, middel en groot`() {
        assertEquals(WidgetSize.MEDIUM, WidgetSize.of(0, 0))
        assertEquals(WidgetSize.SMALL, WidgetSize.of(110, 110))
        assertEquals(WidgetSize.SMALL, WidgetSize.of(250, 80))
        assertEquals(WidgetSize.SMALL, WidgetSize.of(150, 300))
        assertEquals(WidgetSize.MEDIUM, WidgetSize.of(180, 180))
        assertEquals(WidgetSize.MEDIUM, WidgetSize.of(300, 250))
        assertEquals(WidgetSize.LARGE, WidgetSize.of(300, 400))
        assertEquals(WidgetSize.MEDIUM, WidgetSize.of(200, 400))
    }

    @Test
    fun `diepe bomen worden niet dieper ingesprongen dan drie niveaus`() {
        val tasks = (0..6).map { task("n$it", project = "p", parent = if (it == 0) null else "n${it - 1}", order = "a$it") }
        val s = snapshot(tasks, projects = listOf(project("inbox-project"), project("p")))
        assertEquals(listOf(0, 1, 2, 3, 3, 3, 3), items(build(s, WidgetSource.Project("p"))).map { it.depth })
    }
}

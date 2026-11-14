package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/** De regels voor binnenkomen en weggaan, met verzonnen plaatsen. Afstanden zijn naar het noorden vanaf het midden van de plaats. */
class GeofenceTest {
    private val t0 = 1_800_000_000_000L
    private val home = PlaceInfo("place-home-1", "Thuis", 52.0, 5.0, 150)
    private val metersPerDegree = 111_195.0

    /** Een bepaling [meters] ten noorden van het midden van [place], [seconds] na t0. */
    private fun fix(meters: Double, seconds: Long, accuracy: Float? = 20f, place: PlaceInfo = home) =
        Fix(place.lat + meters / metersPerDegree, place.lon, accuracy, t0 + seconds * 1000)

    /** Voert bepalingen één voor één uit op [now] = het tijdstip van de bepaling. Geeft de laatste toestand en alle gebeurtenissen. */
    private class Run(var state: GeoState = GeoState(), val places: List<PlaceInfo>) {
        val events = ArrayList<GeoEvent>()
        var last: GeoOutcome? = null
        fun feed(f: Fix, nowMs: Long = f.atMs): GeoOutcome {
            val outcome = Geofence.evaluate(state, f, places, nowMs)
            state = outcome.state
            events.addAll(outcome.events)
            last = outcome
            return outcome
        }
        fun kinds() = events.map { it.kind }
    }

    private fun run(vararg places: PlaceInfo) = Run(places = places.toList())

    // ---------- eerste keer ----------

    @Test
    fun `de eerste bepaling binnen een plaats geeft geen melding, maar onthoudt dat je er bent`() {
        val r = run(home)
        r.feed(fix(40.0, 0))
        assertTrue(r.events.isEmpty())
        assertEquals(true, r.state.tracks.getValue(home.id).inside)
    }

    @Test
    fun `de eerste bepaling buiten een plaats geeft geen melding`() {
        val r = run(home)
        r.feed(fix(900.0, 0))
        assertTrue(r.events.isEmpty())
        assertEquals(false, r.state.tracks.getValue(home.id).inside)
    }

    @Test
    fun `een slechte eerste bepaling laat de plaats onbekend, een latere goede legt haar vast`() {
        val r = run(home)
        r.feed(fix(160.0, 0, accuracy = 200f)) // te onzeker om iets te zeggen (rand van de cirkel)
        assertNull(r.state.tracks[home.id])
        r.feed(fix(160.0, 60, accuracy = 20f))
        assertEquals(false, r.state.tracks.getValue(home.id).inside)
        assertTrue(r.events.isEmpty())
    }

    @Test
    fun `een slechte maar duidelijk verre bepaling zegt wel dat je buiten bent`() {
        val r = run(home)
        r.feed(fix(2_000.0, 0, accuracy = 200f))
        assertEquals(false, r.state.tracks.getValue(home.id).inside)
    }

    // ---------- aankomst en vertrek ----------

    @Test
    fun `aankomst geeft precies een melding, ook als je blijft`() {
        val r = run(home)
        r.feed(fix(800.0, 0))
        r.feed(fix(300.0, 120))
        assertTrue(r.events.isEmpty())
        r.feed(fix(120.0, 240))
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
        for (i in 1..20) r.feed(fix(50.0 + i, 240L + i * 60))
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
        assertEquals(t0 + 240_000, r.events[0].atMs)
        assertEquals(home.id, r.events[0].placeId)
    }

    @Test
    fun `vertrek geeft precies een melding`() {
        val r = run(home)
        r.feed(fix(10.0, 0))
        r.feed(fix(120.0, 60))
        r.feed(fix(190.0, 120))
        assertTrue("op 190 m is de marge nog niet gehaald", r.events.isEmpty())
        r.feed(fix(260.0, 180))
        assertEquals(listOf(GeoKind.LEAVE), r.kinds())
        r.feed(fix(900.0, 300))
        r.feed(fix(5_000.0, 600))
        assertEquals(listOf(GeoKind.LEAVE), r.kinds())
    }

    @Test
    fun `een volgende binnenkomst geeft weer een melding`() {
        val r = run(home)
        r.feed(fix(10.0, 0))
        r.feed(fix(500.0, 300))
        r.feed(fix(20.0, 900))
        r.feed(fix(600.0, 1_500))
        r.feed(fix(30.0, 2_100))
        assertEquals(listOf(GeoKind.LEAVE, GeoKind.ENTER, GeoKind.LEAVE, GeoKind.ENTER), r.kinds())
    }

    @Test
    fun `vlak binnen de rand telt als binnen, twee meter erbuiten niet`() {
        val a = run(home)
        a.feed(fix(600.0, 0))
        a.feed(fix(149.5, 120))
        assertEquals(listOf(GeoKind.ENTER), a.kinds())
        val b = run(home)
        b.feed(fix(600.0, 0))
        b.feed(fix(152.0, 120))
        assertTrue(b.events.isEmpty())
    }

    // ---------- GPS-ruis ----------

    @Test
    fun `ruis rond de rand geeft een melding en geen reeks`() {
        val r = run(home)
        r.feed(fix(400.0, 0))
        // blijf rond de rand heen en weer springen: tussen 120 en 190 m, de straal is 150
        val pattern = listOf(140.0, 160.0, 125.0, 185.0, 145.0, 190.0, 130.0, 170.0, 148.0, 180.0, 150.0, 199.0, 120.0, 198.0)
        pattern.forEachIndexed { i, m -> r.feed(fix(m, 120L + i * 30)) }
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
    }

    @Test
    fun `een toestel dat stilligt net buiten de rand en ruis heeft, geeft hooguit een melding`() {
        val random = Random(42)
        val r = run(home)
        r.feed(fix(400.0, 0))
        for (i in 1..500) {
            // 10 m buiten de rand; de bepaling zegt 30 m nauwkeurig, de werkelijke ruis per as is dan ongeveer 20 m
            val noisy = 160.0 + random.nextGaussian() * 20.0
            r.feed(fix(noisy, i * 20L, accuracy = 30f))
        }
        assertTrue("hooguit een aankomst, maar kreeg ${r.kinds()}", r.kinds().size <= 1)
    }

    @Test
    fun `een toestel dat stilligt in het midden en ruis heeft, geeft nooit een melding`() {
        val random = Random(7)
        val r = run(home)
        for (i in 0..2_000) {
            val m = Math.abs(random.nextGaussian() * 25.0)
            r.feed(fix(m, i * 20L, accuracy = 40f))
        }
        assertTrue(r.events.isEmpty())
    }

    @Test
    fun `een toestel dat stilligt ver weg en ruis heeft, geeft nooit een melding`() {
        val random = Random(9)
        val r = run(home)
        for (i in 0..2_000) r.feed(fix(1_000.0 + random.nextGaussian() * 40.0, i * 20L, accuracy = 60f))
        assertTrue(r.events.isEmpty())
    }

    @Test
    fun `de gebeurtenissen wisselen altijd af, wat de ruis ook doet`() {
        for (seed in 1L..25L) {
            val random = Random(seed)
            val r = run(home)
            var position = 800.0
            for (i in 0..3_000) {
                // een wandeling heen en weer met ruis, soms een grote stap
                position += random.nextGaussian() * 25.0 + (if (random.nextInt(200) == 0) random.nextGaussian() * 800.0 else 0.0)
                position = position.coerceIn(-3_000.0, 3_000.0)
                r.feed(fix(Math.abs(position) + random.nextGaussian() * 30.0, i * 15L, accuracy = (10 + random.nextInt(60)).toFloat()))
            }
            r.kinds().zipWithNext().forEach { (a, b) -> assertFalse("seed $seed: twee keer $a achter elkaar", a == b) }
            r.events.zipWithNext().forEach { (a, b) -> assertTrue("seed $seed: gebeurtenissen in volgorde", b.atMs - a.atMs >= Geofence.MIN_FLIP_MS) }
        }
    }

    // ---------- nauwkeurigheid ----------

    @Test
    fun `weggaan vraagt dat je zeker buiten de cirkel zit, ook met een onzekere bepaling`() {
        val r = run(home)
        r.feed(fix(10.0, 0))
        r.feed(fix(330.0, 60, accuracy = 150f)) // 330 - 150 = 180 < 150 + 50: misschien nog binnen
        assertTrue(r.events.isEmpty())
        r.feed(fix(330.0, 120, accuracy = 100f)) // 230 >= 200: zeker buiten, met de marge erbij
        assertEquals(listOf(GeoKind.LEAVE), r.kinds())
    }

    @Test
    fun `een bepaling die onzekerder is dan de plaats groot is, bewijst niet dat je binnen bent`() {
        val small = PlaceInfo("place-small", "Brievenbus", 52.0, 5.0, 100)
        val r = run(small)
        r.feed(fix(500.0, 0, place = small))
        r.feed(fix(40.0, 60, accuracy = 130f, place = small)) // 130 > 100: onbruikbaar om binnen te bewijzen
        assertTrue(r.events.isEmpty())
        r.feed(fix(40.0, 120, accuracy = 90f, place = small))
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
    }

    @Test
    fun `bij een grote plaats mag de onzekerheid ook groter zijn`() {
        val big = PlaceInfo("place-big", "Park", 52.0, 5.0, 1_000)
        val r = run(big)
        r.feed(fix(5_000.0, 0, place = big))
        r.feed(fix(500.0, 60, accuracy = 200f, place = big))
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
    }

    @Test
    fun `een bepaling slechter dan 250 meter telt niet, en wordt gemeld`() {
        val r = run(home)
        r.feed(fix(10.0, 0))
        val o = r.feed(fix(5_000.0, 60, accuracy = 260f))
        assertEquals(Ignored.INACCURATE, o.ignored)
        assertEquals(Ignored.INACCURATE, r.state.lastIgnored)
        assertEquals("de laatste bruikbare bepaling blijft staan", t0, r.state.lastFix!!.atMs)
        assertTrue(r.events.isEmpty())
        assertEquals(true, r.state.tracks.getValue(home.id).inside)
    }

    @Test
    fun `zonder opgave van nauwkeurigheid nemen we honderd meter aan`() {
        val r = run(home)
        r.feed(fix(800.0, 0, accuracy = null))
        r.feed(fix(100.0, 60, accuracy = null))
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
        assertEquals(100f, r.state.lastFix!!.accuracyM!!, 0f)
    }

    @Test
    fun `een negatieve of onzinnige nauwkeurigheid geldt als onbekend`() {
        val r = run(home)
        r.feed(fix(800.0, 0, accuracy = -5f))
        r.feed(fix(100.0, 60, accuracy = Float.NaN))
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
    }

    // ---------- snel bewegen ----------

    @Test
    fun `met de auto er dwars door met een bepaling per tien seconden`() {
        // 30 m/s naar het zuiden: begin 600 m ten noorden, elke 10 s 300 m verder
        val r = run(home)
        var m = 600.0
        var t = 0L
        while (m > -700.0) {
            r.feed(fix(Math.abs(m), t, accuracy = 15f))
            m -= 300.0
            t += 10
        }
        // 600, 300, 0, 300, 600 m: binnen bij 0; het vertrek vlak daarna (binnen twee minuten) wacht even
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
        r.feed(fix(900.0, 200, accuracy = 15f))
        assertEquals(listOf(GeoKind.ENTER, GeoKind.LEAVE), r.kinds())
    }

    @Test
    fun `een rit langs de plaats op 500 meter doet niets`() {
        val r = run(home)
        for (i in 0..60) r.feed(fix(500.0 + Math.abs(i - 30) * 5.0, i * 10L, accuracy = 20f))
        assertTrue(r.events.isEmpty())
    }

    @Test
    fun `aankomst met de fiets en daarna weer weg - twee meldingen in de goede volgorde`() {
        val r = run(home)
        r.feed(fix(3_000.0, 0))
        r.feed(fix(1_500.0, 300))
        r.feed(fix(300.0, 600))
        r.feed(fix(60.0, 700))
        r.feed(fix(40.0, 2_000))
        r.feed(fix(200.0, 3_000))
        r.feed(fix(700.0, 3_100))
        assertEquals(listOf(GeoKind.ENTER, GeoKind.LEAVE), r.kinds())
    }

    // ---------- sprongen ----------

    @Test
    fun `een sprong van tientallen kilometers in een paar seconden is een meetfout`() {
        val r = run(home)
        r.feed(fix(10.0, 0))
        val o = r.feed(fix(60_000.0, 5))
        assertEquals(Ignored.JUMP, o.ignored)
        assertTrue(r.events.isEmpty())
        assertEquals(true, r.state.tracks.getValue(home.id).inside)
        r.feed(fix(20.0, 60)) // de volgende gewone bepaling is gewoon thuis
        assertTrue(r.events.isEmpty())
    }

    @Test
    fun `dezelfde afstand na lange tijd is geen sprong maar een reis`() {
        val r = run(home)
        r.feed(fix(10.0, 0))
        r.feed(fix(60_000.0, 40 * 60)) // 60 km in 40 minuten: 25 m/s
        assertEquals(listOf(GeoKind.LEAVE), r.kinds())
    }

    @Test
    fun `een kleine sprong binnen de onzekerheid is geen sprong`() {
        val r = run(home)
        r.feed(fix(10.0, 0, accuracy = 100f))
        val o = r.feed(fix(300.0, 1, accuracy = 100f)) // 290 m in een seconde, maar de onzekerheid is 200 m en de marge 200 m
        assertNull(o.ignored)
    }

    @Test
    fun `een foutieve bepaling die blijft terugkomen wordt na verloop van tijd toch geloofd`() {
        val r = run(home)
        r.feed(fix(10.0, 0))
        assertEquals(Ignored.JUMP, r.feed(fix(50_000.0, 10)).ignored)
        assertEquals(Ignored.JUMP, r.feed(fix(50_000.0, 100)).ignored) // 500 m/s
        assertNull(r.feed(fix(50_000.0, 1_000)).ignored) // 50 m/s: dat kan met een trein
        assertEquals(listOf(GeoKind.LEAVE), r.kinds())
    }

    // ---------- tijd ----------

    @Test
    fun `ontbrekende bepalingen - na uren stilte telt een verandering nog wel`() {
        val r = run(home)
        r.feed(fix(10.0, 0))
        r.feed(fix(4_000.0, 3 * 3600L))
        assertEquals(listOf(GeoKind.LEAVE), r.kinds())
    }

    @Test
    fun `na meer dan twaalf uur stilte is het geen nieuws meer - alleen vastleggen`() {
        val r = run(home)
        r.feed(fix(10.0, 0))
        r.feed(fix(4_000.0, 13 * 3600L))
        assertTrue(r.events.isEmpty())
        assertEquals(false, r.state.tracks.getValue(home.id).inside)
        r.feed(fix(20.0, 13 * 3600L + 3_600))
        assertEquals("daarna werkt alles weer gewoon", listOf(GeoKind.ENTER), r.kinds())
    }

    @Test
    fun `een bepaling van meer dan tien minuten oud (laatst bekende positie) telt niet`() {
        val r = run(home)
        val old = fix(10.0, 0)
        val o = r.feed(old, nowMs = old.atMs + 11 * 60_000)
        assertEquals(Ignored.STALE, o.ignored)
        assertTrue(r.state.tracks.isEmpty())
        assertNull(r.state.lastFix)
        assertEquals("wel onthouden dat we gekeken hebben", old.atMs + 11 * 60_000, r.state.lastCheckMs)
        assertNull(r.feed(old, nowMs = old.atMs + 9 * 60_000).ignored)
    }

    @Test
    fun `een bepaling uit de toekomst telt niet, een klok die iets voorloopt wel`() {
        val r = run(home)
        val f = fix(10.0, 600)
        assertEquals(Ignored.FUTURE, r.feed(f, nowMs = f.atMs - 3 * 60_000).ignored)
        assertNull(r.feed(f, nowMs = f.atMs - 60_000).ignored)
    }

    @Test
    fun `een bepaling die niet nieuwer is dan de vorige telt niet, en een dubbel afgeleverde bepaling geeft geen tweede melding`() {
        val r = run(home)
        r.feed(fix(800.0, 0))
        val arrival = fix(50.0, 300)
        r.feed(arrival)
        assertEquals(Ignored.OLD, r.feed(arrival).ignored)
        assertEquals(Ignored.OLD, r.feed(fix(900.0, 200)).ignored)
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
    }

    @Test
    fun `de klok is terug gezet - de laatste bepaling uit de toekomst wordt vergeten`() {
        val r = run(home)
        r.feed(fix(800.0, 10 * 86_400L)) // een bepaling met een datum ver vooruit
        val later = fix(50.0, 0)
        // "nu" is t0: de eerste bepaling lijkt uit de toekomst te komen
        val o = r.feed(later)
        assertNull(o.ignored)
        assertEquals(later.atMs, r.state.lastFix!!.atMs)
    }

    // ---------- snel heen en weer ----------

    @Test
    fun `na een aankomst volgt een vertrek niet binnen twee minuten`() {
        val r = run(home)
        r.feed(fix(900.0, 0))
        r.feed(fix(40.0, 100))
        r.feed(fix(900.0, 130)) // 30 s later, ver weg (maar niet een sprong: 29 m/s)
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
        r.feed(fix(900.0, 100 + 121))
        assertEquals(listOf(GeoKind.ENTER, GeoKind.LEAVE), r.kinds())
    }

    // ---------- herstart ----------

    @Test
    fun `na een herstart van het toestel gaat het verder waar het was`() {
        val r = run(home)
        r.feed(fix(10.0, 0))
        val restored = GeoStateCodec.decode(GeoStateCodec.encode(r.state))
        assertEquals(r.state, restored)
        val after = Run(restored, listOf(home))
        after.feed(fix(500.0, 900))
        assertEquals(listOf(GeoKind.LEAVE), after.kinds())
        // en nog een keer opslaan en laden geeft geen tweede melding
        val again = Run(GeoStateCodec.decode(GeoStateCodec.encode(after.state)), listOf(home))
        again.feed(fix(520.0, 1_000))
        assertTrue(again.events.isEmpty())
    }

    @Test
    fun `een herstart zonder bewaarde toestand legt alleen vast waar je bent`() {
        val r = Run(GeoStateCodec.decode(null), listOf(home))
        r.feed(fix(10.0, 0))
        assertTrue(r.events.isEmpty())
    }

    // ---------- plaatsen veranderen ----------

    @Test
    fun `een plaats die is verzet of verruimd begint opnieuw, zonder melding`() {
        val r = run(home)
        r.feed(fix(300.0, 0))
        val bigger = home.copy(radiusM = 500)
        val after = Run(r.state, listOf(bigger))
        after.feed(fix(300.0, 60)) // nu binnen de nieuwe cirkel
        assertTrue(after.events.isEmpty())
        assertEquals(true, after.state.tracks.getValue(home.id).inside)
        assertEquals(bigger.signature, after.state.tracks.getValue(home.id).signature)
    }

    @Test
    fun `een hernoemde plaats behoudt wat we weten`() {
        val r = run(home)
        r.feed(fix(300.0, 0))
        val renamed = Run(r.state, listOf(home.copy(name = "Ons huis")))
        renamed.feed(fix(100.0, 120))
        assertEquals(listOf(GeoKind.ENTER), renamed.kinds())
    }

    @Test
    fun `een verwijderde plaats verdwijnt uit de toestand`() {
        val other = PlaceInfo("place-work-1", "Werk", 52.5, 5.5, 200)
        val r = run(home, other)
        r.feed(fix(10.0, 0))
        assertEquals(setOf(home.id, other.id), r.state.tracks.keys)
        val after = Run(r.state, listOf(other))
        after.feed(fix(20.0, 60))
        assertEquals(setOf(other.id), after.state.tracks.keys)
        val flagged = Run(r.state, listOf(home.copy(deleted = true), other))
        flagged.feed(fix(20.0, 60))
        assertEquals(setOf(other.id), flagged.state.tracks.keys)
    }

    // ---------- meer plaatsen ----------

    @Test
    fun `twee plaatsen tegelijk geven elk hun eigen melding in een bepaling`() {
        val shop = PlaceInfo("place-shop-1", "Winkel", 52.0, 5.0, 300) // om hetzelfde midden, grotere straal
        val r = run(home, shop)
        r.feed(fix(2_000.0, 0))
        r.feed(fix(100.0, 300))
        assertEquals(setOf(home.id, shop.id), r.events.map { it.placeId }.toSet())
        assertEquals(2, r.events.size)
        r.feed(fix(500.0, 900)) // weg bij allebei? 500 >= 150+50 en >= 300+75
        assertEquals(4, r.events.size)
        assertEquals(2, r.events.count { it.kind == GeoKind.LEAVE })
    }

    @Test
    fun `een grote cirkel om een kleine - eerst de grote, dan de kleine`() {
        val shop = PlaceInfo("place-shop-1", "Wijk", 52.0, 5.0, 1_000)
        val r = run(home, shop)
        r.feed(fix(5_000.0, 0))
        r.feed(fix(800.0, 600))
        assertEquals(listOf(shop.id), r.events.map { it.placeId })
        r.feed(fix(100.0, 1_200))
        assertEquals(listOf(shop.id, home.id), r.events.map { it.placeId })
    }

    // ---------- aarde ----------

    @Test
    fun `een plaats op de datumgrens - van de ene kant naar de andere`() {
        val fiji = PlaceInfo("place-fiji-1", "Fiji", -17.0, 179.9995, 150)
        val r = run(fiji)
        r.feed(Fix(-17.0, -179.99, 20f, t0))
        r.feed(Fix(-17.0, -179.9996, 20f, t0 + 600_000)) // ongeveer 100 m
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
    }

    @Test
    fun `een plaats vlak bij de pool`() {
        val pole = PlaceInfo("place-pole-1", "Station", 89.9995, 10.0, 150)
        val r = run(pole)
        r.feed(Fix(89.99, -170.0, 20f, t0)) // aan de andere kant van de pool, ruim 1 km
        r.feed(Fix(89.9995, 100.0, 20f, t0 + 600_000)) // zelfde breedte, andere lengte: ongeveer 0,6 m
        assertEquals(listOf(GeoKind.ENTER), r.kinds())
    }

    @Test
    fun `ongeldige coordinaten worden genegeerd`() {
        val r = run(home)
        assertEquals(Ignored.INVALID, r.feed(Fix(95.0, 0.0, 10f, t0)).ignored)
        assertEquals(Ignored.INVALID, r.feed(Fix(0.0, Double.NaN, 10f, t0 + 1_000)).ignored)
        assertNull(r.state.lastFix)
    }

    // ---------- hulpfuncties ----------

    @Test
    fun `de marge buiten de straal`() {
        assertEquals(50.0, Geofence.margin(100), 0.0)
        assertEquals(50.0, Geofence.margin(150), 0.0)
        assertEquals(62.5, Geofence.margin(250), 0.0)
        assertEquals(1_250.0, Geofence.margin(5_000), 0.0)
    }

    @Test
    fun `wanneer een bepaling binnen kan bewijzen`() {
        assertTrue(Geofence.usableForInside(100f, 100))
        assertFalse(Geofence.usableForInside(101f, 100))
        assertTrue(Geofence.usableForInside(150f, 150))
        assertFalse(Geofence.usableForInside(151f, 150))
        assertTrue(Geofence.usableForInside(200f, 1_000))
    }

    @Test
    fun `afstand tot de rand van de dichtstbijzijnde plaats`() {
        val work = PlaceInfo("place-work-1", "Werk", 52.1, 5.0, 300)
        val f = fix(1_000.0, 0)
        val boundary = Geofence.nearestBoundaryM(f, listOf(home, work))!!
        assertEquals(850.0, boundary, 2.0)
        assertNull(Geofence.nearestBoundaryM(f, emptyList()))
        assertNotNull(Geofence.nearestBoundaryM(f, listOf(home.copy(deleted = true), work)))
        assertEquals(0.0, Geofence.nearestBoundaryM(fix(150.0, 0), listOf(home))!!, 1.0)
        assertEquals("binnen: de afstand tot de rand", 100.0, Geofence.nearestBoundaryM(fix(50.0, 0), listOf(home))!!, 1.0)
    }
}

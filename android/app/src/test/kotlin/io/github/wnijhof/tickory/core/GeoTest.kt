package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GeoTest {
    private fun near(expected: Double, actual: Double, tolerance: Double, message: String = "") =
        assertEquals("$message verwacht $expected ± $tolerance", expected, actual, tolerance)

    @Test
    fun `zelfde punt is nul en de afstand is symmetrisch`() {
        assertEquals(0.0, Geo.distanceMeters(52.37, 4.89, 52.37, 4.89), 0.0)
        near(Geo.distanceMeters(52.37, 4.89, 51.92, 4.48), Geo.distanceMeters(51.92, 4.48, 52.37, 4.89), 1e-6)
        near(57_328.0, Geo.distanceMeters(52.37, 4.89, 51.92, 4.48), 50.0)
    }

    @Test
    fun `bekende maten - een graad is ongeveer 111 km`() {
        near(111_195.0, Geo.distanceMeters(0.0, 0.0, 1.0, 0.0), 50.0)
        near(111_195.0, Geo.distanceMeters(0.0, 0.0, 0.0, 1.0), 50.0)
        near(55_597.0, Geo.distanceMeters(60.0, 10.0, 60.0, 11.0), 60.0, "op 60 graden is een graad lengte de helft")
    }

    @Test
    fun `kleine afstanden zijn nauwkeurig`() {
        val dLat = 100.0 / 111_195.0
        near(100.0, Geo.distanceMeters(52.0, 5.0, 52.0 + dLat, 5.0), 0.2)
        val dLon = 100.0 / (111_195.0 * Math.cos(Math.toRadians(52.0)))
        near(100.0, Geo.distanceMeters(52.0, 5.0, 52.0, 5.0 + dLon), 0.2)
        near(10.0, Geo.distanceMeters(52.0, 5.0, 52.0 + 10.0 / 111_195.0, 5.0), 0.05)
    }

    @Test
    fun `over de datumgrens is de weg kort`() {
        near(111.2, Geo.distanceMeters(0.0, 179.9995, 0.0, -179.9995), 0.5)
        near(2_117.0, Geo.distanceMeters(-17.5, 179.99, -17.5, -179.99), 5.0)
        near(0.0, Geo.distanceMeters(10.0, 180.0, 10.0, -180.0), 1e-6, "dezelfde meridiaan")
    }

    @Test
    fun `bij de polen`() {
        near(0.0, Geo.distanceMeters(90.0, 0.0, 90.0, 123.0), 1e-6, "alle lengtes zijn op de pool hetzelfde punt")
        near(0.0, Geo.distanceMeters(-90.0, 10.0, -90.0, -170.0), 1e-6)
        near(22_239.0, Geo.distanceMeters(89.9, 0.0, 89.9, 180.0), 30.0, "over de pool heen")
        near(111_195.0, Geo.distanceMeters(90.0, 0.0, 89.0, 77.0), 50.0)
        near(20_015_087.0, Geo.distanceMeters(90.0, 0.0, -90.0, 0.0), 100.0, "van pool tot pool")
    }

    @Test
    fun `tegenpolen geven geen onmogelijk getal door afrondingsfouten`() {
        near(20_015_087.0, Geo.distanceMeters(0.0, 0.0, 0.0, 180.0), 100.0)
        for ((a, b, c, d) in listOf(listOf(45.0, 10.0, -45.0, -170.0), listOf(33.3, 44.4, -33.3, -135.6), listOf(12.3456, 78.9012, -12.3456, -101.0988))) {
            val x = Geo.distanceMeters(a, b, c, d)
            assertTrue("$a,$b,$c,$d -> $x", x.isFinite() && x in 0.0..20_015_120.0)
        }
    }

    @Test
    fun `geldige coordinaten`() {
        assertTrue(Geo.validCoordinates(90.0, 180.0))
        assertTrue(Geo.validCoordinates(-90.0, -180.0))
        assertFalse(Geo.validCoordinates(90.0001, 0.0))
        assertFalse(Geo.validCoordinates(0.0, -180.0001))
        assertFalse(Geo.validCoordinates(Double.NaN, 0.0))
        assertFalse(Geo.validCoordinates(0.0, Double.POSITIVE_INFINITY))
    }

    @Test
    fun `de handtekening van een plaats verandert met positie of straal, niet met de naam`() {
        val a = PlaceInfo("p1", "Thuis", 52.0, 5.0, 150)
        assertEquals(a.signature, a.copy(name = "Ons huis").signature)
        assertFalse(a.signature == a.copy(radiusM = 300).signature)
        assertFalse(a.signature == a.copy(lat = 52.0001).signature)
        assertFalse(a.signature == a.copy(lon = 5.0001).signature)
    }
}

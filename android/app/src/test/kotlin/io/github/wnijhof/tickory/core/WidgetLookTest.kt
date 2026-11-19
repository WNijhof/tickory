package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** De thema's, weergave, lettergrootte en vooringestelde stijlen van de lijstwidgets. */
class WidgetLookTest {
    @Test
    fun `elk thema heeft licht en donker, behalve Dynamische kleur dat uit de resources komt`() {
        assertNull(WidgetAccent.DYNAMIC.colors(false))
        for (a in WidgetAccent.entries.filter { it != WidgetAccent.DYNAMIC }) {
            val light = a.colors(false)!!
            val dark = a.colors(true)!!
            assertEquals(0xFFFFFFFF.toInt(), light.background)
            assertEquals(0xFF1F1F1F.toInt(), dark.background)
            assertNotEquals(light.toolbar, dark.toolbar)
            assertNotEquals(light.text, dark.text)
        }
        assertEquals(0xFF297ABC.toInt(), WidgetAccent.BLUEBERRY.colors(false)!!.accent)
        assertEquals(0xFF2A7BBD.toInt(), WidgetAccent.BLUEBERRY.colors(true)!!.accent)
    }

    @Test
    fun `datumkleuren en prioriteiten`() {
        val c = WidgetAccent.TOMATO.colors(false)!!
        assertEquals(c.overdue, c.dueColor(DueKind.OVERDUE))
        assertEquals(c.today, c.dueColor(DueKind.TODAY))
        assertEquals(c.tomorrow, c.dueColor(DueKind.TOMORROW))
        assertEquals(c.soon, c.dueColor(DueKind.SOON))
        assertEquals(c.textSoft, c.dueColor(DueKind.LATER))
        assertEquals(c.textSoft, c.dueColor(DueKind.NONE))
        assertEquals(0xFFD1453B.toInt(), c.priority(1))
        assertEquals("iets onmogelijks is geen prioriteit", c.priority(4), c.priority(0))
        assertEquals(c.priority(4), c.priority(9))
    }

    @Test
    fun `een onbekende waarde is de standaard`() {
        assertEquals(WidgetAccent.DYNAMIC, WidgetAccent.parse(null))
        assertEquals(WidgetAccent.DYNAMIC, WidgetAccent.parse("nonsens"))
        assertEquals(WidgetAccent.GOLD, WidgetAccent.parse("gold"))
        assertEquals(WidgetFont.NORMAL, WidgetFont.parse("x"))
        assertTrue(WidgetFont.SMALL.scale < WidgetFont.NORMAL.scale && WidgetFont.NORMAL.scale < WidgetFont.LARGE.scale)
    }

    @Test
    fun `vooringestelde stijlen volgens Todoist`() {
        val base = WidgetOptions(accent = WidgetAccent.GOLD, compact = false, opacity = 20)
        val dark = WidgetPreset.TRANSPARENT_DARK.applyTo(base)
        assertEquals(WidgetTheme.DARK, dark.theme)
        assertEquals(70, dark.opacity)
        val white = WidgetPreset.TRANSPARENT_LIGHT.applyTo(base)
        assertEquals(WidgetTheme.LIGHT, white.theme)
        assertEquals(0, white.opacity)
        assertTrue(WidgetPreset.COMPACT.applyTo(base).compact)
        assertEquals(100, WidgetPreset.STANDARD.applyTo(base).opacity)
        assertEquals(base, WidgetPreset.CUSTOM.applyTo(base))
    }

    @Test
    fun `de stijl wordt herkend aan de opties, anders Aangepast`() {
        assertEquals(WidgetPreset.STANDARD, WidgetPreset.of(WidgetPreset.STANDARD.applyTo(WidgetOptions())))
        assertEquals(WidgetPreset.TRANSPARENT_DARK, WidgetPreset.of(WidgetPreset.TRANSPARENT_DARK.applyTo(WidgetOptions())))
        assertEquals(WidgetPreset.CUSTOM, WidgetPreset.of(WidgetOptions(opacity = 33)))
    }

    @Test
    fun `doorzichtigheid loopt van 0 tot 100 in stappen van 1`() {
        assertEquals(255, WidgetOptions().alpha)
        assertEquals(0, WidgetOptions(opacity = 0).alpha)
        assertEquals(127, WidgetOptions(opacity = 50).alpha)
        assertEquals(100, WidgetOptions.normalizeOpacity(300))
        assertEquals(37, WidgetOptions.normalizeOpacity(37))
    }
}

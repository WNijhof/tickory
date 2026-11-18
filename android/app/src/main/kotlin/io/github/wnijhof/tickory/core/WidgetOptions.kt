package io.github.wnijhof.tickory.core

import kotlin.math.abs

/** Het thema van één widget: het thema van het toestel (met de kleuren van Android 12 en nieuwer), altijd licht of altijd donker. */
enum class WidgetTheme(val key: String) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark"),
    ;

    companion object {
        /** Een onbekende of ontbrekende waarde is het thema van het toestel. */
        fun parse(key: String?): WidgetTheme = entries.firstOrNull { it.key == key } ?: SYSTEM
    }
}

/**
 * De instellingen van één lijstwidget, zoals in de widget van Todoist: het [theme], de [compact]e weergave (de datum staat rechts op
 * dezelfde regel als de titel, zonder tweede regel) en de [opacity] van de achtergrond (100 = dicht, 0 = helemaal doorzichtig).
 */
data class WidgetOptions(
    val theme: WidgetTheme = WidgetTheme.SYSTEM,
    val compact: Boolean = false,
    val opacity: Int = 100,
) {
    /** De doorzichtigheid als waarde voor `setImageAlpha` (0 … 255). */
    val alpha: Int get() = opacity.coerceIn(0, 100) * 255 / 100

    companion object {
        /** De keuzes voor de achtergrond, van dicht naar doorzichtig. */
        val OPACITIES = listOf(100, 75, 50, 25, 0)

        /** De dichtstbijzijnde keuze; iets onzinnigs wordt 100. */
        fun normalizeOpacity(value: Int): Int = if (value !in 0..100) 100 else OPACITIES.minByOrNull { abs(it - value) } ?: 100
    }
}

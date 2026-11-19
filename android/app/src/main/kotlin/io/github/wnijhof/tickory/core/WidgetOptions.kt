package io.github.wnijhof.tickory.core

/** De weergave van een widget: zoals het toestel (automatisch), altijd licht of altijd donker. */
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
 * De instellingen van één lijstwidget, zoals in de widget van Todoist: het [accent] (het thema met kleur), de [theme] (de weergave:
 * automatisch, licht of donker), de [font]grootte, de [compact]e weergave (de datum staat rechts op dezelfde regel als de titel, zonder
 * tweede regel) en de [opacity] van de achtergrond (100 = dicht, 0 = helemaal doorzichtig, elke stap van 1).
 */
data class WidgetOptions(
    val theme: WidgetTheme = WidgetTheme.SYSTEM,
    val compact: Boolean = false,
    val opacity: Int = 100,
    val accent: WidgetAccent = WidgetAccent.DYNAMIC,
    val font: WidgetFont = WidgetFont.NORMAL,
) {
    /** De doorzichtigheid als waarde voor `setImageAlpha` (0 … 255). */
    val alpha: Int get() = opacity.coerceIn(0, 100) * 255 / 100

    companion object {
        /** Een waarde buiten 0 tot en met 100 is 100 (een kapotte of onbekende waarde laat de widget gewoon dicht). */
        fun normalizeOpacity(value: Int): Int = if (value !in 0..100) 100 else value
    }
}

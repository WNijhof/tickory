package io.github.wnijhof.tickory.widget

import android.content.Context
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.WidgetTheme

/**
 * De kleuren van een widget met een gekozen thema. Bij [WidgetTheme.SYSTEM] is er geen palet: dan blijven de kleuren uit de opmaak staan,
 * die vanzelf het thema van het toestel volgen (ook als dat wisselt terwijl de widget niet opnieuw wordt getekend, en met de kleuren van
 * Android 12 en nieuwer).
 */
class WidgetPalette(val background: Int, val text: Int, val textSoft: Int, val accent: Int, val overdue: Int) {
    companion object {
        /** Het palet van een vast licht of donker thema; null voor het thema van het toestel. */
        fun of(context: Context, theme: WidgetTheme): WidgetPalette? = when (theme) {
            WidgetTheme.SYSTEM -> null
            WidgetTheme.LIGHT -> WidgetPalette(
                context.getColor(R.color.widget_light_bg), context.getColor(R.color.widget_light_text), context.getColor(R.color.widget_light_text_soft),
                context.getColor(R.color.widget_light_accent), context.getColor(R.color.widget_light_overdue),
            )
            WidgetTheme.DARK -> WidgetPalette(
                context.getColor(R.color.widget_dark_bg), context.getColor(R.color.widget_dark_text), context.getColor(R.color.widget_dark_text_soft),
                context.getColor(R.color.widget_dark_accent), context.getColor(R.color.widget_dark_overdue),
            )
        }
    }
}

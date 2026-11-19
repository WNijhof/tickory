package io.github.wnijhof.tickory.widget

import android.content.Context
import android.content.res.Configuration
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.WidgetAccent
import io.github.wnijhof.tickory.core.WidgetColors
import io.github.wnijhof.tickory.core.WidgetOptions
import io.github.wnijhof.tickory.core.WidgetTheme

/**
 * De kleuren van een widget, uit het thema en de weergave die de gebruiker koos (zie [WidgetOptions]). Een vast thema (Tomaat, Maansteen, …)
 * heeft een eigen palet in licht en donker; "Dynamische kleur" leest de kleuren uit de resources: de kleuren van het toestel, op Android 12
 * en nieuwer die van het thema van de gebruiker (Material You). Bij "automatisch" volgt de weergave het toestel op het moment dat de widget
 * wordt getekend (bij elke verversing en na elke tik).
 */
object WidgetPalette {
    /** Is de weergave van deze widget donker? Automatisch: zoals het toestel nu is. */
    fun isDark(context: Context, theme: WidgetTheme): Boolean = when (theme) {
        WidgetTheme.DARK -> true
        WidgetTheme.LIGHT -> false
        WidgetTheme.SYSTEM -> (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }

    fun resolve(context: Context, options: WidgetOptions): WidgetColors {
        val dark = isDark(context, options.theme)
        options.accent.colors(dark)?.let { return it }
        // Dynamische kleur: de resources, in licht of donker zoals gekozen (ook als het toestel het andere is)
        val cfg = Configuration(context.resources.configuration)
        cfg.uiMode = (cfg.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or (if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
        val themed = context.createConfigurationContext(cfg)
        fun c(id: Int) = themed.getColor(id)
        return WidgetColors(
            background = c(R.color.widget_bg), toolbar = c(R.color.widget_toolbar), accent = c(R.color.widget_accent), text = c(R.color.widget_text),
            textSoft = c(R.color.widget_text_soft), textFaint = c(R.color.widget_faint), divider = c(R.color.widget_divider), overdue = c(R.color.widget_overdue),
            today = c(R.color.widget_today), tomorrow = c(R.color.widget_tomorrow), soon = c(R.color.widget_soon),
            priorities = listOf(c(R.color.widget_p1), c(R.color.widget_p2), c(R.color.widget_p3), c(R.color.widget_p4)),
        )
    }

    /** De namen van de thema's, voor de instellingen. */
    fun label(context: Context, accent: WidgetAccent): String = context.getString(
        when (accent) {
            WidgetAccent.DYNAMIC -> R.string.widget_accent_dynamic
            WidgetAccent.TOMATO -> R.string.widget_accent_tomato
            WidgetAccent.MOONSTONE -> R.string.widget_accent_moonstone
            WidgetAccent.TANGERINE -> R.string.widget_accent_tangerine
            WidgetAccent.KALE -> R.string.widget_accent_kale
            WidgetAccent.BLUEBERRY -> R.string.widget_accent_blueberry
            WidgetAccent.LAVENDER -> R.string.widget_accent_lavender
            WidgetAccent.RASPBERRY -> R.string.widget_accent_raspberry
            WidgetAccent.GOLD -> R.string.widget_accent_gold
        },
    )
}

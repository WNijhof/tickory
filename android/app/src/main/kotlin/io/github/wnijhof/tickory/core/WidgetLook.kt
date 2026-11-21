package io.github.wnijhof.tickory.core

/**
 * Het uiterlijk van de widgets, zoals in de Todoist-app: een **thema** (de kleur van de balk en de knoppen: Dynamische kleur, Zeegroen (de
 * kleur van Tickory), Tomaat, Maansteen, Mandarijn, Kale, Bosbes, Lavendel, Framboos, Goud), de **weergave** (automatisch, licht of donker, zie [WidgetTheme]), de
 * **lettergrootte**, de doorzichtigheid en de compacte weergave. Zuivere Kotlin: de kleuren staan hier als getallen, zodat ze op de pc te
 * testen zijn.
 */
enum class WidgetAccent(
    val key: String,
    /** De kleur van de knoppen en pictogrammen in de balk (licht en donker). */
    private val accentLight: Int,
    private val accentDark: Int,
    /** De achtergrond van de balk bovenaan (licht en donker). */
    private val toolbarLight: Int,
    private val toolbarDark: Int,
) {
    /** Past zich aan aan het thema van het toestel (Material You); zonder vast palet, de kleuren komen uit de resources. */
    DYNAMIC("dynamic", 0, 0, 0, 0),
    TEAL("teal", 0xFF0F766E.toInt(), 0xFF2DD4BF.toInt(), 0xFFF7FAFA.toInt(), 0xFF242727.toInt()),
    TOMATO("tomato", 0xFFD33322.toInt(), 0xFFDC4C3E.toInt(), 0xFFFCFAF8.toInt(), 0xFF262626.toInt()),
    MOONSTONE("moonstone", 0xFF39485E.toInt(), 0xFF677890.toInt(), 0xFFFAFAFA.toInt(), 0xFF262626.toInt()),
    TANGERINE("tangerine", 0xFFFFBD61.toInt(), 0xFFA36B00.toInt(), 0xFFFCFAF7.toInt(), 0xFF272624.toInt()),
    KALE("kale", 0xFF4C7A45.toInt(), 0xFF53824C.toInt(), 0xFFFCFCF8.toInt(), 0xFF262623.toInt()),
    BLUEBERRY("blueberry", 0xFF297ABC.toInt(), 0xFF2A7BBD.toInt(), 0xFFF8FAFB.toInt(), 0xFF252627.toInt()),
    LAVENDER("lavender", 0xFF766BBD.toInt(), 0xFF776CBD.toInt(), 0xFFF9F9FA.toInt(), 0xFF262627.toInt()),
    RASPBERRY("raspberry", 0xFFC5496C.toInt(), 0xFFC64A6D.toInt(), 0xFFFBF8F8.toInt(), 0xFF282525.toInt()),
    GOLD("gold", 0xFF917203.toInt(), 0xFF917304.toInt(), 0xFFFCFBF8.toInt(), 0xFF272624.toInt()),
    ;

    /** De kleuren bij dit thema, licht of donker; null bij [DYNAMIC] (dan komen ze uit de resources). */
    fun colors(dark: Boolean): WidgetColors? = if (this == DYNAMIC) null else WidgetColors(
        background = if (dark) 0xFF1F1F1F.toInt() else 0xFFFFFFFF.toInt(),
        toolbar = if (dark) toolbarDark else toolbarLight,
        accent = if (dark) accentDark else accentLight,
        text = if (dark) 0xFFFFFFFF.toInt() else 0xFF202020.toInt(),
        textSoft = if (dark) 0xFFCCCCCC.toInt() else 0xFF666666.toInt(),
        textFaint = if (dark) 0xFF808080.toInt() else 0xFF999999.toInt(),
        divider = if (dark) 0xFF3D3D3D.toInt() else 0xFFEEEEEE.toInt(),
        overdue = if (dark) 0xFFFF7066.toInt() else 0xFFD1453B.toInt(),
        today = if (dark) 0xFF25B84C.toInt() else 0xFF058527.toInt(),
        tomorrow = if (dark) 0xFFFF9A14.toInt() else 0xFFAD6200.toInt(),
        soon = if (dark) 0xFFA970FF.toInt() else 0xFF692EC2.toInt(),
        priorities = if (dark) listOf(0xFFFF7066.toInt(), 0xFFFF9A13.toInt(), 0xFF5297FF.toInt(), 0xFFA9A9A9.toInt())
        else listOf(0xFFD1453B.toInt(), 0xFFEB8909.toInt(), 0xFF246FE0.toInt(), 0xFF999999.toInt()),
    )

    companion object {
        /** Een onbekende of ontbrekende waarde is Dynamische kleur (het thema van het toestel), zoals een widget die al stond. */
        fun parse(key: String?): WidgetAccent = entries.firstOrNull { it.key == key } ?: DYNAMIC
    }
}

/**
 * De kleuren van een widget met een vast thema.
 * @property toolbar de achtergrond van de balk bovenaan; de rest van het vlak is [background]
 * @property textFaint de kleur van de lege staat en kleine hulptekst
 * @property overdue, [today], [tomorrow], [soon] de kleuren van een datum: te laat, vandaag, morgen, de komende week
 * @property priorities de kleur van de cirkel bij prioriteit 1 tot en met 4
 */
data class WidgetColors(
    val background: Int,
    val toolbar: Int,
    val accent: Int,
    val text: Int,
    val textSoft: Int,
    val textFaint: Int,
    val divider: Int,
    val overdue: Int,
    val today: Int,
    val tomorrow: Int,
    val soon: Int,
    val priorities: List<Int>,
) {
    fun priority(p: Int): Int = priorities[(if (p in 1..4) p else 4) - 1]

    /** De kleur van een datum volgens [kind]; zonder bijzondere kleur de gewone tweede tekstkleur. */
    fun dueColor(kind: DueKind): Int = when (kind) {
        DueKind.OVERDUE -> overdue
        DueKind.TODAY -> today
        DueKind.TOMORROW -> tomorrow
        DueKind.SOON -> soon
        else -> textSoft
    }
}

/** Hoe een datum in een lijst gekleurd wordt: te laat (rood), vandaag (groen), morgen (oranje), de komende week (paars), later of geen. */
enum class DueKind { NONE, OVERDUE, TODAY, TOMORROW, SOON, LATER }

/** De lettergrootte van een lijstwidget: klein, normaal of groot (zoals in Todoist); [scale] vermenigvuldigt alle lettergroottes. */
enum class WidgetFont(val key: String, val scale: Float) {
    SMALL("small", 0.88f),
    NORMAL("normal", 1f),
    LARGE("large", 1.18f),
    ;

    companion object {
        fun parse(key: String?): WidgetFont = entries.firstOrNull { it.key == key } ?: NORMAL
    }
}

/**
 * De vooringestelde stijlen van de instellingen (zoals in Todoist): "Standaard" (het thema Zeegroen, dicht), "Compact", "Transparant donker"
 * (donker, 70% ondoorzichtig) en "Transparant wit" (licht, 0% ondoorzichtig, neutraal thema); "Aangepast" is wat je zelf instelde.
 */
enum class WidgetPreset(val key: String) {
    CUSTOM("custom"),
    STANDARD("standard"),
    COMPACT("compact"),
    TRANSPARENT_DARK("transparent_dark"),
    TRANSPARENT_LIGHT("transparent_light"),
    ;

    /** De opties van deze stijl; [CUSTOM] verandert niets. */
    fun applyTo(current: WidgetOptions): WidgetOptions = when (this) {
        CUSTOM -> current
        STANDARD -> current.copy(accent = WidgetAccent.TEAL, theme = WidgetTheme.SYSTEM, opacity = 100, compact = false, font = WidgetFont.NORMAL)
        COMPACT -> current.copy(accent = WidgetAccent.TEAL, theme = WidgetTheme.SYSTEM, opacity = 100, compact = true, font = WidgetFont.NORMAL)
        TRANSPARENT_DARK -> current.copy(accent = WidgetAccent.MOONSTONE, theme = WidgetTheme.DARK, opacity = 70, compact = false, font = WidgetFont.NORMAL)
        TRANSPARENT_LIGHT -> current.copy(accent = WidgetAccent.MOONSTONE, theme = WidgetTheme.LIGHT, opacity = 0, compact = false, font = WidgetFont.NORMAL)
    }

    companion object {
        /** Welke stijl de opties nu zijn: een van de vaste, anders "Aangepast". */
        fun of(options: WidgetOptions): WidgetPreset = entries.firstOrNull { it != CUSTOM && it.applyTo(options) == options } ?: CUSTOM
    }
}

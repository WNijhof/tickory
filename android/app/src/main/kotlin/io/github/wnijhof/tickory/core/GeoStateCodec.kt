package io.github.wnijhof.tickory.core

/** Bewaart de toestand van de locatiecontrole als JSON-tekst (op het toestel zelf). Onleesbare tekst geeft een lege toestand. */
object GeoStateCodec {
    private const val VERSION = 1L

    fun encode(state: GeoState): String = Json.stringify(
        mapOf(
            "v" to VERSION,
            "tracks" to state.tracks.map { (id, t) ->
                mapOf("id" to id, "inside" to t.inside, "checked" to t.checkedMs, "event" to t.lastEventMs, "sig" to t.signature)
            },
            "fix" to state.lastFix?.let { mapOf("lat" to it.lat, "lon" to it.lon, "acc" to it.accuracyM?.toDouble(), "at" to it.atMs) },
            "check" to state.lastCheckMs,
            "ignored" to state.lastIgnored?.name,
        ),
    )

    fun decode(text: String?): GeoState {
        val root = Json.parseObject(text) ?: return GeoState()
        if (root.whole("v") != VERSION) return GeoState()
        val tracks = HashMap<String, PlaceTrack>()
        for (entry in root.list("tracks") ?: emptyList()) {
            val o = Json.asObject(entry) ?: continue
            val id = o.text("id")?.takeIf(Ids::isSafeId) ?: continue
            tracks[id] = PlaceTrack(o.flag("inside"), o.whole("checked") ?: continue, o.whole("event"), o.text("sig") ?: continue)
        }
        val fix = root.obj("fix")?.let { o ->
            val lat = o.real("lat") ?: return@let null
            val lon = o.real("lon") ?: return@let null
            if (!Geo.validCoordinates(lat, lon)) return@let null
            Fix(lat, lon, o.real("acc")?.toFloat(), o.whole("at") ?: return@let null)
        }
        val ignored = root.text("ignored")?.let { name -> Ignored.entries.firstOrNull { it.name == name } }
        return GeoState(tracks, fix, root.whole("check") ?: 0L, ignored)
    }
}

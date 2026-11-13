package io.github.wnijhof.tickory.store

import android.content.Context
import androidx.core.content.edit
import io.github.wnijhof.tickory.core.ReminderState
import io.github.wnijhof.tickory.core.StateCodec

/**
 * Bewaart wat gepland, uitgesteld en al getoond is, plus de gegevens van de laatste verversing. Daarmee komt alles
 * terug na een herstart van het toestel, ook zonder internet. Privé-opslag van de app, niet in back-ups.
 */
object ReminderStore {
    private const val FILE = "tickory_reminders"
    private const val KEY = "state"

    fun load(context: Context): ReminderState =
        StateCodec.decode(context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY, null))

    fun save(context: Context, state: ReminderState) {
        // commit en niet apply: na een alarm kan het proces meteen weer worden stilgelegd, en dan moet dit al op schijf staan
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit(commit = true) { putString(KEY, StateCodec.encode(state)) }
    }
}

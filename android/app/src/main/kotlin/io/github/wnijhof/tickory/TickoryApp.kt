package io.github.wnijhof.tickory

import android.app.Application
import io.github.wnijhof.tickory.reminders.Notifications

class TickoryApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Het kanaal moet bestaan voordat de eerste melding komt, en zo staat het ook meteen in de instellingen van Android.
        Notifications.ensureChannel(this)
    }
}

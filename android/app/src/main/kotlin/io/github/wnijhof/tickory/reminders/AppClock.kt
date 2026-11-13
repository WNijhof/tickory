package io.github.wnijhof.tickory.reminders

/** De klok van de app. Op de telefoon gewoon de systeemklok; in tests te vervangen, zodat "nu" vastligt. */
object AppClock {
    @Volatile
    var now: () -> Long = { System.currentTimeMillis() }
}

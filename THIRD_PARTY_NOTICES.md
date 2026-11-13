# Software van derden

`client/vendor/nlDatum.generated.js` is een gebundeld bestand (gegenereerd met esbuild uit een eerder project met Nederlandse datumherkenning). Het bevat de bibliotheek **chrono-node** 2.10.3, die onder de MIT-licentie valt. Daarvoor geldt de volgende kennisgeving:

```
The MIT License

Copyright (c) 2014, Wanasit Tanakitrungruang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Verder gebruikt dit project geen software van derden in de server en de web-app: die draaien op Node.js zelf en op standaard web-API's. Voor de Android-app zie onderaan.

## Android-app (APK)

De Android-app (map `android/`) gebruikt, alle onder de Apache-licentie 2.0: AndroidX (core, activity, work, lifecycle, room, sqlite, startup, savedstate, profileinstaller, collection, concurrent, tracing, annotation), de Kotlin-standaardbibliotheek, kotlinx-coroutines, kotlinx-serialization-core, Guava ListenableFuture, JetBrains annotations en JSpecify. In de repo staat verder `gradle-wrapper.jar` (Apache-2.0). De widgets (map `android/app/src/main/kotlin/.../widget`) gebruiken alleen klassen van Android zelf (`AppWidgetProvider`, `RemoteViews`, `RemoteViewsService`); daar is geen bibliotheek voor bijgekomen. Alleen voor de tests: JUnit 4 (EPL-1.0), Robolectric (MIT) en AndroidX Test (Apache-2.0); die komen niet in de APK.

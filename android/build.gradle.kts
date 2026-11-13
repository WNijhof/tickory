// De Android Gradle Plugin compileert Kotlin zelf ("built-in Kotlin", sinds versie 9). Daarom staat hier geen
// Kotlin-plugin; deze regel kiest alleen een nieuwere Kotlin-versie dan de plugin standaard meebrengt.
buildscript {
    dependencies {
        classpath(libs.kotlin.gradle.plugin)
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
}

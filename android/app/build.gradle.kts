plugins {
    alias(libs.plugins.android.application)
}

// ---------- versie: één bron, de package.json van de server ----------
// 0.1.1 -> versienaam "0.1.1", versiecode 101 (major * 10000 + minor * 100 + patch).
val packageJson = providers.fileContents(rootProject.layout.projectDirectory.file("../package.json")).asText.get()
val appVersionName: String = Regex("\"version\"\\s*:\\s*\"(\\d+\\.\\d+\\.\\d+)\"").find(packageJson)?.groupValues?.get(1)
    ?: throw GradleException("Geen geldige \"version\" (x.y.z) gevonden in ../package.json")
val versionParts = appVersionName.split('.').map { it.toInt() }
if (versionParts[1] > 99 || versionParts[2] > 99) {
    throw GradleException("Versie $appVersionName past niet in de versiecode: minor en patch mogen hooguit 99 zijn")
}
val appVersionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]

// ---------- ondertekening van de release: alleen als de sleutel via de omgeving is meegegeven ----------
fun env(name: String): String? = providers.environmentVariable(name).orNull?.takeIf { it.isNotBlank() }
val keystorePath = env("ANDROID_KEYSTORE_FILE")
val keystorePassword = env("ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = env("ANDROID_KEY_ALIAS")
val releaseKeyPassword = env("ANDROID_KEY_PASSWORD")
val signingValues = listOf(keystorePath, keystorePassword, releaseKeyAlias, releaseKeyPassword)
val signRelease = signingValues.all { it != null }
if (!signRelease && signingValues.any { it != null }) {
    throw GradleException(
        "De ondertekening is maar half ingesteld. Zet alle vier: ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD, " +
            "ANDROID_KEY_ALIAS en ANDROID_KEY_PASSWORD (of geen van alle voor een ongetekende release)."
    )
}
if (signRelease && !file(keystorePath!!).isFile) {
    throw GradleException("ANDROID_KEYSTORE_FILE wijst naar een bestand dat niet bestaat: $keystorePath")
}

base {
    archivesName.set("tickory")
}

android {
    namespace = "io.github.wnijhof.tickory"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "io.github.wnijhof.tickory"
        minSdk = 26
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersionName
    }

    androidResources {
        // Alleen onze eigen talen in de APK. Zonder dit brengen de androidx-bibliotheken tientallen talen mee, en kiest
        // Android bij bijvoorbeeld "Frans, daarna Engels" voor Frans (dat wij niet hebben) in plaats van Engels.
        localeFilters += listOf("nl", "en")
    }

    signingConfigs {
        if (signRelease) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // Bewust geen codeverkleining (R8): wat de unit-tests draaien is dan precies wat op de telefoon draait.
            isMinifyEnabled = false
            if (signRelease) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        abortOnError = true
        lintConfig = file("lint.xml")
    }

    testOptions {
        unitTests {
            // Nodig voor de tests die Android nabootsen (Robolectric): die lezen het manifest en de teksten van de app.
            isIncludeAndroidResources = true
        }
    }
}

// ---------- Nederlands ook als uitgesproken taal ----------
// De standaardteksten (res/values) zijn Nederlands. Android kiest bij de taalvolgorde "Nederlands, daarna Engels" echter
// voor Engels als er alleen values-en bestaat: "geen taal opgegeven" telt niet als Nederlands. Daarom maakt de build een
// kopie van de standaardteksten als values-nl. Eén bron in de repo, geen dubbel onderhoud.
abstract class CopyDutchStrings : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val source: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val target = outputDir.get().asFile.resolve("values-nl")
        target.mkdirs()
        source.get().asFile.copyTo(target.resolve("strings.xml"), overwrite = true)
    }
}

androidComponents {
    onVariants { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        val task = tasks.register<CopyDutchStrings>("generate${name}DutchStrings") {
            source.set(layout.projectDirectory.file("src/main/res/values/strings.xml"))
        }
        variant.sources.res?.addGeneratedSourceDirectory(task, CopyDutchStrings::outputDir)
    }
}

tasks.withType<Test>().configureEach {
    // De test tegen een echte server (zie README) draait alleen als dit adres is opgegeven; een ander adres is een andere invoer.
    inputs.property("tickoryTestServer", providers.environmentVariable("TICKORY_TEST_SERVER").orElse(""))
    testLogging {
        events("failed", "skipped")
        showStandardStreams = false
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.work.runtime)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.work.testing)
}

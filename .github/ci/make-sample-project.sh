#!/usr/bin/env bash
# Generates a minimal Kotlin + Jetpack Compose app used by CI to prove real APK builds on aarch64.
#   make-sample-project.sh <dir> <stack: agp8 | latest>
# Prints the chosen versions. Requires `gradle` on PATH (to generate the wrapper) and curl.
set -euo pipefail
DIR="$1"; STACK="$2"

latest_maven() { # <metadata url>  -> highest stable version (digits and dots only)
  curl -fsSL --retry 3 "$1" | grep -oE '<version>[0-9]+(\.[0-9]+)*</version>' | sed -E 's#</?version>##g' | sort -V | tail -n1
}
G=https://dl.google.com/dl/android/maven2
C=https://repo1.maven.org/maven2

case "$STACK" in
  agp8)
    AGP=8.7.3; KOTLIN=2.0.21; GRADLE=8.11.1; BOM=2024.12.01; ACTIVITY=1.9.3; SDK=35 ;;
  latest)
    AGP="$(latest_maven $G/com/android/tools/build/gradle/maven-metadata.xml)"
    KOTLIN="$(latest_maven $C/org/jetbrains/kotlin/kotlin-gradle-plugin/maven-metadata.xml)"
    GRADLE="$(curl -fsSL https://services.gradle.org/versions/current | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
    BOM="$(curl -fsSL --retry 3 $G/androidx/compose/compose-bom/maven-metadata.xml | grep -oE '<version>[0-9]{4}\.[0-9]{2}\.[0-9]{2}</version>' | sed -E 's#</?version>##g' | sort -V | tail -n1)"
    ACTIVITY="$(latest_maven $G/androidx/activity/activity-compose/maven-metadata.xml)"
    # Current androidx (Compose 1.13+, core 1.19+) requires compileSdk >= 37.1
    SDK="${LATEST_COMPILE_SDK:-37.2}" ;;
  *) echo "unknown stack $STACK"; exit 2 ;;
esac
AGP_MAJOR="${AGP%%.*}"
SDK_MAJOR="${SDK%%.*}"
if [ "$SDK" != "$SDK_MAJOR" ]; then # minor API level, e.g. 37.2 (AGP 8.13+ DSL)
  COMPILE_SDK="compileSdk { version = release($SDK_MAJOR) { minorApiLevel = ${SDK#*.} } }"
else
  COMPILE_SDK="compileSdk = $SDK"
fi
echo "stack=$STACK agp=$AGP kotlin=$KOTLIN gradle=$GRADLE compose-bom=$BOM activity=$ACTIVITY compileSdk=$SDK"

mkdir -p "$DIR/app/src/main/java/dev/runner/sample" "$DIR/app/src/main/res/values" "$DIR/app/src/main/res/drawable"
cd "$DIR"
# Generate the wrapper first, in an empty build: the host Gradle may be too old to configure the real one.
echo 'rootProject.name = "RunnerSample"' > settings.gradle.kts
gradle wrapper --gradle-version "$GRADLE" --distribution-type bin -q

cat > settings.gradle.kts <<KTS
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "RunnerSample"
include(":app")
KTS

if [ "$AGP_MAJOR" -ge 9 ]; then
  # AGP 9+: built-in Kotlin, no org.jetbrains.kotlin.android plugin
  KOTLIN_ROOT=''; KOTLIN_APP=''; KOTLIN_OPTS=''
else
  KOTLIN_ROOT="    id(\"org.jetbrains.kotlin.android\") version \"$KOTLIN\" apply false"
  KOTLIN_APP='    id("org.jetbrains.kotlin.android")'
  KOTLIN_OPTS='    kotlinOptions { jvmTarget = "17" }'
fi

cat > build.gradle.kts <<KTS
plugins {
    id("com.android.application") version "$AGP" apply false
$KOTLIN_ROOT
    id("org.jetbrains.kotlin.plugin.compose") version "$KOTLIN" apply false
}
KTS

cat > gradle.properties <<'PROPS'
android.useAndroidX=true
PROPS

cat > app/build.gradle.kts <<KTS
plugins {
    id("com.android.application")
$KOTLIN_APP
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.runner.sample"
    $COMPILE_SDK
    defaultConfig {
        applicationId = "dev.runner.sample"
        minSdk = 24
        targetSdk = $SDK_MAJOR
        versionCode = 1
        versionName = "1.0"
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
$KOTLIN_OPTS
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:$BOM"))
    implementation("androidx.activity:activity-compose:$ACTIVITY")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
}
KTS

cat > app/src/main/AndroidManifest.xml <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="@string/app_name" android:icon="@drawable/ic_launcher" android:theme="@style/AppTheme">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
XML

cat > app/src/main/res/values/strings.xml <<'XML'
<resources><string name="app_name">Runner Sample</string><string name="hello">Built on aarch64</string></resources>
XML
cat > app/src/main/res/values/themes.xml <<'XML'
<resources><style name="AppTheme" parent="android:Theme.Material.Light.NoActionBar" /></resources>
XML
cat > app/src/main/res/drawable/ic_launcher.xml <<'XML'
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="48dp" android:height="48dp"
    android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#3DDC84" android:pathData="M12,2L2,22h20z" />
</vector>
XML

cat > app/src/main/java/dev/runner/sample/MainActivity.kt <<'KT'
package dev.runner.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { Greeting() } }
    }
}

@Composable
fun Greeting() {
    Text(stringResource(R.string.hello))
}
KT

printf 'build/\n.gradle/\napp/build/\nlocal.properties\n*.jks\n' > .gitignore
git init -q -b main && git add -A && git -c user.name=ci -c user.email=ci@example.com commit -q -m "sample app"
echo "sample project ready in $DIR"

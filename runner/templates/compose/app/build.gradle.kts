plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "__PACKAGE__"
    compileSdk {
        version = release(__COMPILE_SDK__) { minorApiLevel = __COMPILE_SDK_MINOR__ }
    }

    defaultConfig {
        applicationId = "__PACKAGE__"
        minSdk = __MIN_SDK__
        targetSdk = __TARGET_SDK__
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:__COMPOSE_BOM__"))
    implementation("androidx.core:core-ktx:__CORE_KTX__")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:__LIFECYCLE__")
    implementation("androidx.activity:activity-compose:__ACTIVITY__")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:__JUNIT__")
}

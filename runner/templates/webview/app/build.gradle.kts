plugins {
    id("com.android.application")
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
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.core:core-ktx:__CORE_KTX__")
    implementation("androidx.activity:activity-ktx:__ACTIVITY__")
    testImplementation("junit:junit:__JUNIT__")
}

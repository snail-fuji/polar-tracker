package com.anonymous.app

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.*

// Keeps the CPU awake during a recording session so JS timers (reconnect backoff)
// keep firing in Doze, and lets the app ask for a battery-optimization exemption.
class RecordingPowerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private var wakeLock: PowerManager.WakeLock? = null

  override fun getName() = "RecordingPower"

  private val powerManager: PowerManager
    get() = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager

  @ReactMethod
  fun acquireWakeLock(promise: Promise) {
    if (wakeLock?.isHeld != true) {
      wakeLock = powerManager
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PolarTracker::Recording")
          .apply { setReferenceCounted(false); acquire() }
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun releaseWakeLock(promise: Promise) {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    promise.resolve(null)
  }

  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    promise.resolve(powerManager.isIgnoringBatteryOptimizations(reactContext.packageName))
  }

  @SuppressLint("BatteryLife")
  @ReactMethod
  fun requestIgnoreBatteryOptimizations(promise: Promise) {
    try {
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
          .setData(Uri.parse("package:${reactContext.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(intent)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("BATTERY_OPT_ERROR", e.message, e)
    }
  }

  override fun invalidate() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.invalidate()
  }
}

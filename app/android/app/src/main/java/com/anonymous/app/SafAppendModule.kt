package com.anonymous.app

import android.net.Uri
import com.facebook.react.bridge.*
import java.io.IOException
import java.io.OutputStreamWriter

class SafAppendModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "SafAppend"

  @ReactMethod
  fun appendToSafUri(uriString: String, content: String, promise: Promise) {
    try {
      val uri = Uri.parse(uriString)
      val stream = reactContext.contentResolver.openOutputStream(uri, "wa")
        ?: throw IOException("openOutputStream returned null for $uriString")
      stream.use { OutputStreamWriter(it).use { w -> w.write(content) } }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("SAF_APPEND_ERROR", e.message, e)
    }
  }
}

package com.anonymous.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class SafAppendPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext) = listOf(SafAppendModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

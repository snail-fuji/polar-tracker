import { NativeModules, Platform } from 'react-native';

const { RecordingPower } = NativeModules;
const isAndroid = Platform.OS === 'android' && !!RecordingPower;

export function acquireWakeLock() {
  return isAndroid ? RecordingPower.acquireWakeLock() : Promise.resolve();
}

export function releaseWakeLock() {
  return isAndroid ? RecordingPower.releaseWakeLock() : Promise.resolve();
}

export function isIgnoringBatteryOptimizations() {
  return isAndroid ? RecordingPower.isIgnoringBatteryOptimizations() : Promise.resolve(true);
}

export function requestIgnoreBatteryOptimizations() {
  return isAndroid ? RecordingPower.requestIgnoreBatteryOptimizations() : Promise.resolve();
}

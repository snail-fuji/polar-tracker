import { NativeModules } from 'react-native';

const { SafAppend } = NativeModules;

export function appendToSafUri(uri, content) {
  return SafAppend.appendToSafUri(uri, content);
}

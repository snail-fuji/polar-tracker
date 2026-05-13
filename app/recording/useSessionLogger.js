import { useCallback, useRef } from 'react';
import {
  StorageAccessFramework,
  writeAsStringAsync,
  readAsStringAsync,
  deleteAsync,
  documentDirectory,
  EncodingType,
} from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SAF_DIR_KEY = 'polar_saf_dir_uri';

async function getSavedDirUri() {
  try { return await AsyncStorage.getItem(SAF_DIR_KEY); } catch { return null; }
}

async function pickDirectory() {
  const result = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!result.granted) return null;
  await AsyncStorage.setItem(SAF_DIR_KEY, result.directoryUri);
  return result.directoryUri;
}

async function createCsv(dirUri, name) {
  return StorageAccessFramework.createFileAsync(dirUri, name, 'text/csv');
}

function buildTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const UTF8 = { encoding: EncodingType.UTF8 };
const enc  = new TextEncoder();

// Append lines to a file:// temp file using FileHandle offset trick.
// (FileHandle works with file:// URIs; SAF content:// URIs are not supported.)
function appendToTmp(path, lines) {
  if (!lines.length) return;
  const handle = new File(path).open();
  handle.offset = handle.size; // offset > size → writeBytes appends
  handle.writeBytes(enc.encode(lines.join('\n') + '\n'));
  handle.close();
}

export function useSessionLogger() {
  const sessionRef = useRef(null);

  const startSession = useCallback(async () => {
    let dirUri = await getSavedDirUri();
    if (!dirUri) {
      dirUri = await pickDirectory();
      if (!dirUri) return false;
    }

    const ts = buildTimestamp();
    let ecgUri, eventsUri, accUri;
    try {
      ecgUri    = await createCsv(dirUri, `polar_${ts}_ecg`);
      eventsUri = await createCsv(dirUri, `polar_${ts}_events`);
      accUri    = await createCsv(dirUri, `polar_${ts}_acc`);
    } catch (e) {
      await AsyncStorage.removeItem(SAF_DIR_KEY);
      throw new Error(`Не удалось создать файлы: ${e.message}. Попробуйте ещё раз — появится выбор папки.`);
    }

    // Temp files in documentDirectory — append works here, SAF doesn't support it
    const ecgTmp    = `${documentDirectory}${ts}_ecg.csv`;
    const accTmp    = `${documentDirectory}${ts}_acc.csv`;
    const eventsTmp = `${documentDirectory}${ts}_events.csv`;

    await Promise.all([
      writeAsStringAsync(ecgTmp,    'timestamp_s,ecg_mV\n',                      UTF8),
      writeAsStringAsync(accTmp,    'timestamp_s,acc_x_mG,acc_y_mG,acc_z_mG\n',  UTF8),
      writeAsStringAsync(eventsTmp, 'timestamp_s,stress,description\n',           UTF8),
    ]);

    sessionRef.current = {
      ecgUri, accUri, eventsUri,
      ecgTmp, accTmp, eventsTmp,
      ecgLines: [], accLines: [], eventLines: [],
    };
    return true;
  }, []);

  const logEcgPoints = useCallback((pts) => {
    if (!sessionRef.current) return;
    for (const p of pts)
      sessionRef.current.ecgLines.push(`${p.x.toFixed(4)},${p.y.toFixed(6)}`);
  }, []);

  const logAccPoints = useCallback((pts) => {
    if (!sessionRef.current) return;
    for (const p of pts)
      sessionRef.current.accLines.push(`${p.t.toFixed(4)},${p.x},${p.y},${p.z}`);
  }, []);

  const logEvent = useCallback((event) => {
    if (!sessionRef.current) return;
    const desc = event.description.replace(/"/g, '""');
    sessionRef.current.eventLines.push(`${event.timeS.toFixed(3)},${event.stress},"${desc}"`);
  }, []);

  // Drains in-memory buffers and appends chunks to temp files via FileHandle.
  const flushSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    appendToTmp(session.ecgTmp,    session.ecgLines.splice(0));
    appendToTmp(session.accTmp,    session.accLines.splice(0));
    appendToTmp(session.eventsTmp, session.eventLines.splice(0));
  }, []);

  // Final flush → copy temp files to SAF → delete temp files.
  const endSession = useCallback(async () => {
    if (!sessionRef.current) return null;
    flushSession();
    const session = sessionRef.current;
    sessionRef.current = null;

    const [ecgContent, accContent, eventsContent] = await Promise.all([
      readAsStringAsync(session.ecgTmp,    UTF8),
      readAsStringAsync(session.accTmp,    UTF8),
      readAsStringAsync(session.eventsTmp, UTF8),
    ]);
    await Promise.all([
      writeAsStringAsync(session.ecgUri,    ecgContent,    UTF8),
      writeAsStringAsync(session.accUri,    accContent,    UTF8),
      writeAsStringAsync(session.eventsUri, eventsContent, UTF8),
    ]);
    await Promise.all([
      deleteAsync(session.ecgTmp,    { idempotent: true }),
      deleteAsync(session.accTmp,    { idempotent: true }),
      deleteAsync(session.eventsTmp, { idempotent: true }),
    ]);

    return { ecgUri: session.ecgUri, accUri: session.accUri, eventsUri: session.eventsUri };
  }, [flushSession]);

  const resetDirectory = useCallback(async () => {
    await AsyncStorage.removeItem(SAF_DIR_KEY);
  }, []);

  return { startSession, logEcgPoints, logAccPoints, logEvent, flushSession, endSession, resetDirectory };
}

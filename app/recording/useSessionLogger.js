import { useCallback, useRef } from 'react';
import { StorageAccessFramework, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SAF_DIR_KEY = 'polar_saf_dir_uri';

// Returns a persisted SAF directory URI, or null if not yet chosen.
async function getSavedDirUri() {
  try {
    return await AsyncStorage.getItem(SAF_DIR_KEY);
  } catch {
    return null;
  }
}

// Shows the system folder picker and saves the chosen URI.
async function pickDirectory() {
  const result = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!result.granted) return null;
  await AsyncStorage.setItem(SAF_DIR_KEY, result.directoryUri);
  return result.directoryUri;
}

// Creates a .csv file in the SAF directory and returns its URI.
async function createCsv(dirUri, name) {
  return StorageAccessFramework.createFileAsync(dirUri, name, 'text/csv');
}

function buildTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function useSessionLogger() {
  const sessionRef = useRef(null);

  // Returns true if session started, false if user cancelled the folder picker.
  const startSession = useCallback(async () => {
    let dirUri = await getSavedDirUri();

    if (!dirUri) {
      dirUri = await pickDirectory();
      if (!dirUri) return false; // user cancelled
    }

    const ts = buildTimestamp();
    let ecgUri, eventsUri;
    try {
      ecgUri    = await createCsv(dirUri, `polar_${ts}_ecg`);
      eventsUri = await createCsv(dirUri, `polar_${ts}_events`);
    } catch (e) {
      // Permission may have been revoked — clear and let user re-pick next time
      await AsyncStorage.removeItem(SAF_DIR_KEY);
      throw new Error(`Не удалось создать файлы: ${e.message}. Попробуйте ещё раз — появится выбор папки.`);
    }

    sessionRef.current = { ecgUri, eventsUri, ecgLines: [], eventLines: [] };
    return true;
  }, []);

  const logEcgPoints = useCallback((pts) => {
    if (!sessionRef.current) return;
    for (const p of pts) {
      sessionRef.current.ecgLines.push(`${p.x.toFixed(4)},${p.y.toFixed(6)}`);
    }
  }, []);

  const logEvent = useCallback((event) => {
    if (!sessionRef.current) return;
    const desc = event.description.replace(/"/g, '""');
    sessionRef.current.eventLines.push(
      `${event.time.toISOString()},${event.stress},"${desc}"`,
    );
  }, []);

  const endSession = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return null;
    sessionRef.current = null;

    const ecgContent    = 'timestamp_s,ecg_mV\n'           + session.ecgLines.join('\n')   + '\n';
    const eventsContent = 'timestamp,stress,description\n' + session.eventLines.join('\n') + (session.eventLines.length ? '\n' : '');

    await writeAsStringAsync(session.ecgUri,    ecgContent,    { encoding: EncodingType.UTF8 });
    await writeAsStringAsync(session.eventsUri, eventsContent, { encoding: EncodingType.UTF8 });

    return { ecgUri: session.ecgUri, eventsUri: session.eventsUri };
  }, []);

  // Call to forget the saved folder and show picker again next session
  const resetDirectory = useCallback(async () => {
    await AsyncStorage.removeItem(SAF_DIR_KEY);
  }, []);

  return { startSession, logEcgPoints, logEvent, endSession, resetDirectory };
}

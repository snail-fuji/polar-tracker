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

const SAF_DIR_KEY        = 'polar_saf_dir_uri';
const ACTIVE_SESSION_KEY = 'polar_active_session';

// 32 KB covers ~10s of ECG (130 Hz × ~20 B/line = 26 KB) with margin
const TAIL_BYTES = 32_768;

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
const dec  = new TextDecoder();

function appendToTmp(path, lines) {
  if (!lines.length) return;
  const handle = new File(path).open();
  handle.offset = handle.size;
  handle.writeBytes(enc.encode(lines.join('\n') + '\n'));
  handle.close();
}

// Read last TAIL_BYTES of a tmp file synchronously; skip first partial line.
function readTail(path) {
  try {
    const handle = new File(path).open();
    const size = handle.size ?? 0;
    if (size === 0) { handle.close(); return ''; }
    const start = Math.max(0, size - TAIL_BYTES);
    handle.offset = start;
    const bytes = handle.readBytes(size - start);
    handle.close();
    const text = dec.decode(bytes);
    // If we read from mid-file, the first line may be partial — drop it
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  }
}

function formatEvent(e) {
  const desc = e.description.replace(/"/g, '""');
  return `${e.timeS.toFixed(3)},${e.stress},"${desc}"`;
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

    const ecgTmp = `${documentDirectory}${ts}_ecg.csv`;
    const accTmp = `${documentDirectory}${ts}_acc.csv`;

    await Promise.all([
      writeAsStringAsync(ecgTmp,    'timestamp_s,ecg_mV\n',                     UTF8),
      writeAsStringAsync(accTmp,    'timestamp_s,acc_x_mG,acc_y_mG,acc_z_mG\n', UTF8),
      writeAsStringAsync(eventsUri, 'timestamp_s,stress,description\n',          UTF8),
    ]);

    sessionRef.current = { ecgUri, accUri, eventsUri, ecgTmp, accTmp, ecgLines: [], accLines: [] };
    await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ ecgUri, accUri, eventsUri, ecgTmp, accTmp }));
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

  const writeEvents = useCallback(async (evts) => {
    const session = sessionRef.current;
    if (!session) return;
    const lines = ['timestamp_s,stress,description', ...evts.map(formatEvent)];
    await writeAsStringAsync(session.eventsUri, lines.join('\n') + '\n', UTF8);
  }, []);

  const readEvents = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return [];
    try {
      const content = await readAsStringAsync(session.eventsUri, UTF8);
      return content.split('\n').slice(1).filter(Boolean).map((line, i) => {
        const m = line.match(/^([^,]+),([^,]+),"(.*)"$/s);
        if (!m) return null;
        return { id: i, timeS: parseFloat(m[1]), stress: m[2], description: m[3].replace(/""/g, '"') };
      }).filter(Boolean);
    } catch {
      return [];
    }
  }, []);

  // Reads last ~5s from tmp files synchronously — O(1) regardless of session length.
  const readRecentPoints = useCallback((windowSeconds = 5) => {
    const session = sessionRef.current;
    if (!session) return { ecg: [], acc: [] };
    const tail = (raw, n, parse) =>
      raw.split('\n').filter(Boolean).slice(-n).map(parse).filter(Boolean);
    const ecg = tail(readTail(session.ecgTmp), Math.round(130 * windowSeconds), (line) => {
      const [x, y] = line.split(',');
      const px = parseFloat(x), py = parseFloat(y);
      return isNaN(px) || isNaN(py) ? null : { x: px, y: py };
    });
    const acc = tail(readTail(session.accTmp), Math.round(25 * windowSeconds), (line) => {
      const [t, x, y, z] = line.split(',');
      const pt = parseFloat(t);
      return isNaN(pt) ? null : { t: pt, x: parseFloat(x), y: parseFloat(y), z: parseFloat(z) };
    });
    return { ecg, acc };
  }, []);

  // Drains in-memory buffers to tmp files only. Fast and sync.
  // SAF copy happens via syncToSaf() on AppState 'active' and endSession().
  const flushSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    appendToTmp(session.ecgTmp, session.ecgLines.splice(0));
    appendToTmp(session.accTmp, session.accLines.splice(0));
  }, []);

  // Full tmp → SAF copy. Called when user opens the UI or session ends.
  const syncToSaf = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    const [ecg, acc] = await Promise.all([
      readAsStringAsync(session.ecgTmp, UTF8),
      readAsStringAsync(session.accTmp, UTF8),
    ]);
    await Promise.all([
      writeAsStringAsync(session.ecgUri, ecg, UTF8),
      writeAsStringAsync(session.accUri, acc, UTF8),
    ]);
  }, []);

  const endSession = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return null;
    flushSession();
    await syncToSaf();
    sessionRef.current = null;
    await AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
    await Promise.all([
      deleteAsync(session.ecgTmp, { idempotent: true }),
      deleteAsync(session.accTmp, { idempotent: true }),
    ]);
    return { ecgUri: session.ecgUri, accUri: session.accUri, eventsUri: session.eventsUri };
  }, [flushSession, syncToSaf]);

  const restoreSession = useCallback(async () => {
    try {
      const saved = await AsyncStorage.getItem(ACTIVE_SESSION_KEY);
      if (!saved) return false;
      const meta = JSON.parse(saved);
      sessionRef.current = { ...meta, ecgLines: [], accLines: [] };
      return true;
    } catch {
      return false;
    }
  }, []);

  const resetDirectory = useCallback(async () => {
    await AsyncStorage.removeItem(SAF_DIR_KEY);
  }, []);

  return {
    startSession, restoreSession,
    logEcgPoints, logAccPoints,
    writeEvents, readEvents,
    flushSession, syncToSaf, endSession, resetDirectory, readRecentPoints,
  };
}

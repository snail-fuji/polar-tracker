import { useCallback, useRef } from 'react';
import { StorageAccessFramework, writeAsStringAsync, readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { appendToSafUri } from '../native/safAppend';

const SAF_DIR_KEY        = 'polar_saf_dir_uri';
const ACTIVE_SESSION_KEY = 'polar_active_session';

// In-memory ring buffer: keep last MAX_RING points per stream.
// At 130 Hz ECG and 25 Hz ACC, 10s = 1300 + 250 points — well within budget.
const MAX_ECG_RING = 1400;
const MAX_ACC_RING = 300;

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

function formatEvent(e) {
  const desc = e.description.replace(/"/g, '""');
  return `${e.timeS.toFixed(3)},${e.stress},"${desc}"`;
}

// Push items into a capped ring array in-place.
function pushRing(ring, items, max) {
  ring.push(...items);
  if (ring.length > max) ring.splice(0, ring.length - max);
}

// Parse last N lines from a CSV string (skipping header), returning parsed points.
function parseTailLines(content, n, parse) {
  const lines = content.split('\n').filter(Boolean);
  // skip header row
  return lines.slice(Math.max(1, lines.length - n)).map(parse).filter(Boolean);
}

export function useSessionLogger() {
  const sessionRef = useRef(null);

  // ecgRing / accRing: in-memory ring buffers for graph display
  const ecgRing = useRef([]);
  const accRing = useRef([]);

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

    await Promise.all([
      appendToSafUri(ecgUri,    'timestamp_s,ecg_mV\n'),
      appendToSafUri(accUri,    'timestamp_s,acc_x_mG,acc_y_mG,acc_z_mG\n'),
      writeAsStringAsync(eventsUri, 'timestamp_s,stress,description\n', UTF8),
    ]);

    ecgRing.current = [];
    accRing.current = [];

    sessionRef.current = { ecgUri, accUri, eventsUri, ecgLines: [], accLines: [] };
    await AsyncStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ ecgUri, accUri, eventsUri }));
    return true;
  }, []);

  const logEcgPoints = useCallback((pts) => {
    if (!sessionRef.current) return;
    for (const p of pts)
      sessionRef.current.ecgLines.push(`${p.x.toFixed(4)},${p.y.toFixed(6)}`);
    pushRing(ecgRing.current, pts, MAX_ECG_RING);
  }, []);

  const logAccPoints = useCallback((pts) => {
    if (!sessionRef.current) return;
    for (const p of pts)
      sessionRef.current.accLines.push(`${p.t.toFixed(4)},${p.x},${p.y},${p.z}`);
    pushRing(accRing.current, pts, MAX_ACC_RING);
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

  // Returns last windowSeconds of data from in-memory ring buffers.
  const readRecentPoints = useCallback((windowSeconds = 5) => {
    const ecg = ecgRing.current.slice(-Math.round(130 * windowSeconds));
    const acc = accRing.current.slice(-Math.round(25 * windowSeconds));
    return { ecg, acc };
  }, []);

  // Drains in-memory line buffers → SAF files (async append).
  const flushSession = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    const ecgChunk = session.ecgLines.splice(0);
    const accChunk = session.accLines.splice(0);
    const writes = [];
    if (ecgChunk.length) writes.push(appendToSafUri(session.ecgUri, ecgChunk.join('\n') + '\n'));
    if (accChunk.length) writes.push(appendToSafUri(session.accUri, accChunk.join('\n') + '\n'));
    if (writes.length) await Promise.all(writes);
  }, []);

  const endSession = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return null;
    await flushSession();
    sessionRef.current = null;
    ecgRing.current = [];
    accRing.current = [];
    await AsyncStorage.removeItem(ACTIVE_SESSION_KEY);
    return { ecgUri: session.ecgUri, accUri: session.accUri, eventsUri: session.eventsUri };
  }, [flushSession]);

  // Restores session metadata from AsyncStorage and pre-populates ring buffers
  // by reading the tail of the SAF files (one-time, on mount).
  const restoreSession = useCallback(async () => {
    try {
      const saved = await AsyncStorage.getItem(ACTIVE_SESSION_KEY);
      if (!saved) return false;
      const meta = JSON.parse(saved);
      sessionRef.current = { ...meta, ecgLines: [], accLines: [] };

      // Pre-populate ring buffers from existing SAF data so graph shows immediately.
      const [ecgContent, accContent] = await Promise.all([
        readAsStringAsync(meta.ecgUri, UTF8).catch(() => ''),
        readAsStringAsync(meta.accUri, UTF8).catch(() => ''),
      ]);
      ecgRing.current = parseTailLines(ecgContent, MAX_ECG_RING, (line) => {
        const [x, y] = line.split(',');
        const px = parseFloat(x), py = parseFloat(y);
        return isNaN(px) || isNaN(py) ? null : { x: px, y: py };
      });
      accRing.current = parseTailLines(accContent, MAX_ACC_RING, (line) => {
        const [t, x, y, z] = line.split(',');
        const pt = parseFloat(t);
        return isNaN(pt) ? null : { t: pt, x: parseFloat(x), y: parseFloat(y), z: parseFloat(z) };
      });

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
    flushSession, endSession, resetDirectory, readRecentPoints,
  };
}

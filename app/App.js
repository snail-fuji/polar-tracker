import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import EcgGraph from './components/EcgGraph';
import AccGraph from './components/AccGraph';
import EventsTable from './components/EventsTable';
import AddEventModal from './components/AddEventModal';
import { usePolarH10 } from './ble/usePolarH10';
import { useSessionLogger } from './recording/useSessionLogger';

const SAMPLE_RATE = 130;
const WINDOW_SECONDS = 5;
const MAX_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS; // 650
const DRAIN_INTERVAL_MS = 100;

const ACC_SAMPLE_RATE  = 25;
const MAX_ACC_SAMPLES  = ACC_SAMPLE_RATE * WINDOW_SECONDS; // 125

const STATUS_LABEL = {
  idle:       { text: 'Остановлено',           color: '#6b7280' },
  scanning:   { text: 'Поиск Polar H10…',      color: '#d97706' },
  connecting: { text: 'Подключение…',          color: '#d97706' },
  streaming:  { text: 'Запись',                color: '#16a34a' },
  error:      { text: 'Ошибка',                color: '#dc2626' },
};

export default function App() {
  const [ecgData, setEcgData] = useState([]);
  const [accData, setAccData] = useState([]);
  const [events, setEvents] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [savedPaths, setSavedPaths] = useState(null);
  const pendingEventTime = useRef(null);

  const { bleStatus, bleError, deviceName, sampleCount, startBle, stopBle, drainSamples, drainAccSamples, getSessionElapsed } = usePolarH10();
  const { startSession, logEcgPoints, logAccPoints, logEvent, endSession, resetDirectory } = useSessionLogger();
  const isRecording = bleStatus === 'streaming';

  // Drain BLE buffers → update graphs + write to CSV
  useEffect(() => {
    if (!isRecording) return;
    const id = setInterval(() => {
      // ECG
      const ecgPts = drainSamples();
      if (ecgPts.length > 0) {
        logEcgPoints(ecgPts);
        setEcgData((prev) => {
          const next = [...prev, ...ecgPts];
          return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
        });
      }

      // ACC — amplitude per sample, 5-second rolling window
      const accPts = drainAccSamples();
      if (accPts.length > 0) {
        logAccPoints(accPts);
        const amplPts = accPts.map(({ t, x, y, z }) => ({
          x: t,
          y: Math.sqrt(x * x + y * y + z * z),
        }));
        setAccData((prev) => {
          const next = [...prev, ...amplPts];
          return next.length > MAX_ACC_SAMPLES ? next.slice(next.length - MAX_ACC_SAMPLES) : next;
        });
      }
    }, DRAIN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isRecording, drainSamples, drainAccSamples, logEcgPoints, logAccPoints]); // eslint-disable-line

  const handleToggleRecording = async () => {
    if (bleStatus === 'idle' || bleStatus === 'error') {
      setSavedPaths(null);
      setEcgData([]);
      setAccData([]);
      setEvents([]);
      let sessionStarted = false;
      try {
        sessionStarted = await startSession();
      } catch (e) {
        console.error('startSession failed:', e);
        Alert.alert('Ошибка записи файла', String(e?.message ?? e));
        return;
      }
      if (!sessionStarted) return; // user cancelled folder picker
      await startBle();
    } else {
      await stopBle();
      try {
        const paths = await endSession();
        setSavedPaths(paths);
      } catch (e) {
        console.error('endSession failed:', e);
        Alert.alert('Ошибка сохранения файла', String(e?.message ?? e));
      }
      setEcgData([]);
    }
  };

  const handleAddEvent = () => {
    pendingEventTime.current = getSessionElapsed();
    setShowModal(true);
  };

  const handleEventConfirm = ({ description, stress }) => {
    const event = { id: Date.now(), timeS: pendingEventTime.current, description, stress };
    setEvents((prev) => [...prev, event]);
    logEvent(event); // sync, no await
    setShowModal(false);
  };

  const statusInfo = STATUS_LABEL[bleStatus] ?? STATUS_LABEL.idle;
  const recordBtnLabel =
    bleStatus === 'idle'      ? '⏺  Start recording' :
    bleStatus === 'scanning'  ? '⏳  Scanning…'        :
    bleStatus === 'connecting'? '⏳  Connecting…'      :
    bleStatus === 'streaming' ? '⏹  Stop recording'   :
                                '⏺  Retry';

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

        <Text style={styles.title}>Polar H10 Tracker</Text>

        {/* Record toggle */}
        <TouchableOpacity
          style={[
            styles.recordBtn,
            isRecording && styles.recordBtnActive,
            (bleStatus === 'scanning' || bleStatus === 'connecting') && styles.recordBtnPending,
          ]}
          onPress={handleToggleRecording}
          disabled={bleStatus === 'scanning' || bleStatus === 'connecting'}
          activeOpacity={0.8}
        >
          <Text style={styles.recordBtnText}>{recordBtnLabel}</Text>
        </TouchableOpacity>

        {/* Status */}
        <Text style={styles.statusLabel}>
          Recording status:{' '}
          <Text style={{ color: statusInfo.color, fontWeight: '600' }}>
            {statusInfo.text}
          </Text>
        </Text>
        {deviceName && (
          <Text style={styles.deviceName}>📡 {deviceName}</Text>
        )}
        {bleStatus === 'streaming' && (
          <Text style={styles.debugText}>samples received: {sampleCount}</Text>
        )}
        {bleStatus === 'error' && bleError && (
          <Text style={styles.errorText}>{bleError}</Text>
        )}


        {/* Events */}
        <Text style={styles.sectionLabel}>Tracked events</Text>
        <EventsTable events={events} />

        <TouchableOpacity style={styles.addBtn} onPress={handleAddEvent} activeOpacity={0.8}>
          <Text style={styles.addBtnText}>＋  Add Event</Text>
        </TouchableOpacity>

        {/* ECG Graph */}
        <Text style={styles.sectionLabel}>ECG — последние 5 секунд</Text>
        <EcgGraph data={ecgData} />
        <Text style={styles.hint}>Pinch / drag для масштабирования по времени</Text>

        {/* ACC Graph */}
        <Text style={styles.sectionLabel}>Акселерометр — последние 5 секунд</Text>
        <AccGraph data={accData} />
        <Text style={styles.hint}>Pinch / drag для масштабирования по времени</Text>

      </ScrollView>

      <AddEventModal
        visible={showModal}
        onConfirm={handleEventConfirm}
        onCancel={() => setShowModal(false)}
      />

      <Modal
        visible={!!savedPaths}
        transparent
        animationType="fade"
        onRequestClose={() => setSavedPaths(null)}
      >
        <View style={styles.savedOverlay}>
          <View style={styles.savedDialog}>
            <Text style={styles.savedDialogTitle}>Сессия сохранена</Text>
            <Text style={styles.savedDialogSub}>Файлы записаны в выбранную папку:</Text>
            <View style={styles.savedFiles}>
              <Text style={styles.savedPath}>{savedPaths?.ecgUri?.split('/').pop()    ?? 'ecg.csv'}</Text>
              <Text style={styles.savedPath}>{savedPaths?.accUri?.split('/').pop()    ?? 'acc.csv'}</Text>
              <Text style={styles.savedPath}>{savedPaths?.eventsUri?.split('/').pop() ?? 'events.csv'}</Text>
            </View>
            <TouchableOpacity style={styles.savedOkBtn} onPress={() => setSavedPaths(null)} activeOpacity={0.8}>
              <Text style={styles.savedOkText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  scroll: { padding: 16, gap: 12 },

  title: { fontSize: 26, fontWeight: '700', color: '#111827' },

  recordBtn: {
    backgroundColor: '#16a34a',
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: 'center',
  },
  recordBtnActive:   { backgroundColor: '#dc2626' },
  recordBtnPending:  { backgroundColor: '#d97706' },
  recordBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },

  statusLabel: { fontSize: 14, color: '#6b7280' },
  deviceName:  { fontSize: 13, color: '#4f46e5', marginTop: -4 },
  debugText:   { fontSize: 11, color: '#9ca3af', marginTop: -4 },
  errorText:   { fontSize: 13, color: '#dc2626', marginTop: -4 },

  sectionLabel: { fontSize: 15, fontWeight: '600', color: '#111827', marginTop: 6 },
  hint:         { fontSize: 11, color: '#9ca3af', textAlign: 'center', marginTop: -4 },

  addBtn: {
    backgroundColor: '#4f46e5',
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 24,
  },
  addBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  savedOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  savedDialog: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 24,
    gap: 12,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
  },
  savedDialogTitle: { fontSize: 17, fontWeight: '700', color: '#111827' },
  savedDialogSub:   { fontSize: 13, color: '#6b7280' },
  savedFiles: { gap: 4 },
  savedPath:  { fontSize: 12, color: '#166534', fontFamily: 'monospace' },
  savedOkBtn: {
    backgroundColor: '#16a34a',
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  savedOkText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});

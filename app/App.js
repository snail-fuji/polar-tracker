import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import EcgGraph from './components/EcgGraph';
import EventsTable from './components/EventsTable';
import AddEventModal from './components/AddEventModal';
import { usePolarH10 } from './ble/usePolarH10';
import { useSessionLogger } from './recording/useSessionLogger';

const SAMPLE_RATE = 130;
const WINDOW_SECONDS = 5;
const MAX_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS; // 650
const DRAIN_INTERVAL_MS = 100;

const STATUS_LABEL = {
  idle:       { text: 'Остановлено',           color: '#6b7280' },
  scanning:   { text: 'Поиск Polar H10…',      color: '#d97706' },
  connecting: { text: 'Подключение…',          color: '#d97706' },
  streaming:  { text: 'Запись',                color: '#16a34a' },
  error:      { text: 'Ошибка',                color: '#dc2626' },
};

export default function App() {
  const [ecgData, setEcgData] = useState([]);
  const [events, setEvents] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [savedPaths, setSavedPaths] = useState(null);
  const pendingEventTime = useRef(null);

  const { bleStatus, bleError, deviceName, sampleCount, startBle, stopBle, drainSamples } = usePolarH10();
  const { startSession, logEcgPoints, logEvent, endSession, resetDirectory } = useSessionLogger();
  const isRecording = bleStatus === 'streaming';

  // Drain BLE buffer → update graph + write to CSV
  useEffect(() => {
    if (!isRecording) return;
    const id = setInterval(() => {
      const pts = drainSamples();
      if (pts.length === 0) return;
      logEcgPoints(pts);
      setEcgData((prev) => {
        const next = [...prev, ...pts];
        return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
      });
    }, DRAIN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isRecording, drainSamples, logEcgPoints]);

  const handleToggleRecording = async () => {
    if (bleStatus === 'idle' || bleStatus === 'error') {
      setSavedPaths(null);
      setEcgData([]);
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
    pendingEventTime.current = new Date();
    setShowModal(true);
  };

  const handleEventConfirm = ({ description, stress }) => {
    const event = { id: Date.now(), time: pendingEventTime.current, description, stress };
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

        {/* Saved session paths */}
        {savedPaths && (
          <View style={styles.savedBox}>
            <Text style={styles.savedTitle}>✅ Сессия сохранена в выбранную папку</Text>
            <Text style={styles.savedPath}>{savedPaths.ecgUri?.split('/').pop() ?? 'ecg.csv'}</Text>
            <Text style={styles.savedPath}>{savedPaths.eventsUri?.split('/').pop() ?? 'events.csv'}</Text>
          </View>
        )}

        {/* Graph */}
        <Text style={styles.sectionLabel}>ECG — последние 5 секунд</Text>
        <EcgGraph data={ecgData} />
        <Text style={styles.hint}>Pinch / drag для масштабирования по времени</Text>

        {/* Events */}
        <Text style={styles.sectionLabel}>Tracked events</Text>
        <EventsTable events={events} />

        <TouchableOpacity style={styles.addBtn} onPress={handleAddEvent} activeOpacity={0.8}>
          <Text style={styles.addBtnText}>＋  Add Event</Text>
        </TouchableOpacity>

      </ScrollView>

      <AddEventModal
        visible={showModal}
        onConfirm={handleEventConfirm}
        onCancel={() => setShowModal(false)}
      />
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

  savedBox: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  savedTitle: { fontSize: 13, fontWeight: '600', color: '#15803d' },
  savedPath:  { fontSize: 11, color: '#166534', fontFamily: 'monospace' },
});

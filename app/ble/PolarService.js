import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State } from 'react-native-ble-plx';
import BackgroundActions from 'react-native-background-actions';
import {
  PMD_SERVICE, PMD_CONTROL, PMD_DATA,
  ECG_START, ECG_STOP,
  ACC_FS, ACC_START, ACC_STOP,
  bytesToBase64, base64ToBytes,
  parseEcgFrame, parseAccFrame, extractFrameTimestampNs,
} from './polarProtocol';

const SAMPLE_RATE = 130;
const FLUSH_EVERY_SAMPLES = SAMPLE_RATE * 5; // flush every ~5s of ECG data
const SCAN_TIMEOUT_MS = 12000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RECONNECT_ATTEMPTS = 10;

async function requestBlePermissions() {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(result).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
  }
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

// status: 'idle' | 'scanning' | 'connecting' | 'streaming' | 'reconnecting' | 'error'
class PolarService {
  constructor() {
    this._manager = new BleManager();
    this._status = 'idle';
    this._errorMsg = null;
    this._device = null;
    this._deviceId = null;
    this._deviceName = null;

    this._ecgBuffer = [];
    this._accBuffer = [];
    this._sessionStartNs = null;
    this._sessionWallMs = null;

    this._listeners = new Set();
    this._dataSubscription = null;
    this._ctrlSubscription = null;
    this._disconnectSubscription = null;
    this._scanTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._stopped = true;
    this._resolveTask = null;
    this._onFlush = null;
    this._samplesSinceFlush = 0;

    // Resume reconnect if Bluetooth was toggled off and back on mid-session
    this._bleStateSub = this._manager.onStateChange((state) => {
      if (state === State.PoweredOn && this._status === 'reconnecting' && !this._stopped) {
        clearTimeout(this._reconnectTimer);
        this._connect();
      }
    }, true);
  }

  // --- Public API ---

  getSnapshot() {
    return { status: this._status, errorMsg: this._errorMsg, deviceName: this._deviceName };
  }

  // Returns unsubscribe function; fires immediately with current snapshot
  subscribe(listener) {
    this._listeners.add(listener);
    listener(this.getSnapshot());
    return () => this._listeners.delete(listener);
  }

  drainEcg() {
    const pts = this._ecgBuffer;
    this._ecgBuffer = [];
    return pts;
  }

  drainAcc() {
    const pts = this._accBuffer;
    this._accBuffer = [];
    return pts;
  }

  setFlushCallback(fn) {
    this._onFlush = fn;
  }

  getSessionElapsed() {
    if (!this._sessionWallMs) return 0;
    return (Date.now() - this._sessionWallMs) / 1000;
  }

  async start() {
    if (!this._stopped) return;

    // Must request BT permissions BEFORE BackgroundActions.start() —
    // Android validates BLUETOOTH_CONNECT synchronously inside startForeground()
    // which fires before _backgroundTask even runs.
    const bleState = await this._manager.state();
    if (bleState !== State.PoweredOn) {
      this._setStatus('error', 'Bluetooth выключен — включите и попробуйте снова');
      return;
    }
    if (!(await requestBlePermissions())) {
      this._setStatus('error', 'Нет разрешений Bluetooth');
      return;
    }

    this._stopped = false;
    this._reconnectAttempts = 0;
    this._ecgBuffer = [];
    this._accBuffer = [];
    this._sessionStartNs = null;
    this._sessionWallMs = null;
    this._samplesSinceFlush = 0;
    this._deviceId = null;
    this._deviceName = null;
    this._errorMsg = null;

    await BackgroundActions.start(this._backgroundTask, {
      taskName: 'PolarRecording',
      taskTitle: 'Polar H10 — запись',
      taskDesc: 'Сбор данных ЭКГ и акселерометра',
      taskIcon: { name: 'ic_notification', type: 'drawable' },
      color: '#16a34a',
      foregroundServiceType: ['connectedDevice'],
      parameters: {},
    });
  }

  async stop() {
    this._stopped = true;
    clearTimeout(this._scanTimer);
    clearTimeout(this._reconnectTimer);
    this._cleanupSubscriptions();

    if (this._device) {
      try {
        const isConn = await this._device.isConnected();
        if (isConn) {
          await this._device.writeCharacteristicWithResponseForService(
            PMD_SERVICE, PMD_CONTROL, bytesToBase64(ECG_STOP),
          );
          await this._device.writeCharacteristicWithResponseForService(
            PMD_SERVICE, PMD_CONTROL, bytesToBase64(ACC_STOP),
          );
          await this._device.cancelConnection();
        }
      } catch (_) {}
      this._device = null;
    }

    this._onFlush = null;
    this._resolveTask?.();
    this._resolveTask = null;
    try { await BackgroundActions.stop(); } catch (_) {}

    this._setStatus('idle');
    this._deviceName = null;
    this._errorMsg = null;
  }

  // --- Private ---

  _backgroundTask = async () => {
    try {
      await this._connect();
    } catch (e) {
      this._setStatus('error', e.message);
    }
    // Keep the foreground service alive until stop() resolves this promise.
    // Periodic flush is driven by _handleFrame sample count — not by a JS timer —
    // because JS timers are throttled in background even with FGS.
    await new Promise((resolve) => { this._resolveTask = resolve; });
  };

  _setStatus(status, errorMsg = null) {
    if (this._status === status && this._errorMsg === errorMsg) return;
    this._status = status;
    this._errorMsg = errorMsg;
    const snap = this.getSnapshot();
    this._listeners.forEach((l) => l(snap));
  }

  _cleanupSubscriptions() {
    clearTimeout(this._scanTimer);
    this._manager.stopDeviceScan();
    this._ctrlSubscription?.remove();
    this._ctrlSubscription = null;
    this._dataSubscription?.remove();
    this._dataSubscription = null;
    this._disconnectSubscription?.remove();
    this._disconnectSubscription = null;
  }

  async _connect() {
    const bleState = await this._manager.state();
    if (bleState !== State.PoweredOn) {
      // onStateChange will call _connect() again when BT comes back
      this._setStatus('reconnecting');
      return;
    }

    if (!(await requestBlePermissions())) {
      this._setStatus('error', 'Нет разрешений Bluetooth');
      return;
    }

    if (this._deviceId) {
      await this._connectToKnownDevice();
    } else {
      await this._scan();
    }
  }

  async _scan() {
    this._setStatus('scanning');

    this._scanTimer = setTimeout(() => {
      this._manager.stopDeviceScan();
      if (!this._stopped) this._scheduleReconnect();
    }, SCAN_TIMEOUT_MS);

    this._manager.startDeviceScan(null, { allowDuplicates: false }, async (err, device) => {
      if (err || !device?.name?.toLowerCase().includes('polar')) return;

      clearTimeout(this._scanTimer);
      this._manager.stopDeviceScan();
      this._deviceId = device.id;
      this._deviceName = device.name;
      await this._connectToDevice(device);
    });
  }

  async _connectToKnownDevice() {
    this._setStatus('connecting');
    try {
      const device = await this._manager.connectToDevice(this._deviceId, { autoConnect: false });
      await this._setupDevice(device);
    } catch (_) {
      if (!this._stopped) this._scheduleReconnect();
    }
  }

  async _connectToDevice(device) {
    this._setStatus('connecting');
    try {
      const connected = await device.connect({ autoConnect: false });
      await this._setupDevice(connected);
    } catch (_) {
      if (!this._stopped) this._scheduleReconnect();
    }
  }

  async _setupDevice(connected) {
    await connected.discoverAllServicesAndCharacteristics();
    await connected.requestMTU(232);
    this._device = connected;

    this._disconnectSubscription = this._manager.onDeviceDisconnected(connected.id, () => {
      if (this._stopped) return;
      this._cleanupSubscriptions();
      this._device = null;
      this._scheduleReconnect();
    });

    this._ctrlSubscription = connected.monitorCharacteristicForService(
      PMD_SERVICE, PMD_CONTROL,
      (err, char) => {
        if (err || !char?.value) return;
        const bytes = base64ToBytes(char.value);
        // ECG start error (response op=0x02, type=0x00, error_code != 0x00)
        if (bytes[0] === 0xF0 && bytes[2] === 0x00 && bytes[3] !== 0x00) {
          if (!this._stopped) this._scheduleReconnect();
        }
      },
    );

    this._dataSubscription = connected.monitorCharacteristicForService(
      PMD_SERVICE, PMD_DATA,
      (err, char) => {
        if (err) {
          if (!this._stopped) {
            this._cleanupSubscriptions();
            this._scheduleReconnect();
          }
          return;
        }
        if (!char?.value) return;
        this._handleFrame(base64ToBytes(char.value));
      },
    );

    await connected.writeCharacteristicWithResponseForService(
      PMD_SERVICE, PMD_CONTROL, bytesToBase64(ECG_START),
    );
    await new Promise((r) => setTimeout(r, 300));
    await connected.writeCharacteristicWithResponseForService(
      PMD_SERVICE, PMD_CONTROL, bytesToBase64(ACC_START),
    );

    this._reconnectAttempts = 0;
    this._setStatus('streaming');
  }

  _handleFrame(bytes) {
    if (bytes[0] === 0x00) {
      const samples = parseEcgFrame(bytes);
      if (!samples.length) return;
      const frameNs = extractFrameTimestampNs(bytes);
      if (!this._sessionStartNs) {
        this._sessionStartNs = frameNs;
        this._sessionWallMs = Date.now();
      }
      const baseS = Number(frameNs - this._sessionStartNs) / 1e9;
      samples.forEach((uV, i) => {
        this._ecgBuffer.push({ x: baseS + i / SAMPLE_RATE, y: uV * 1e-3 });
      });
      this._samplesSinceFlush += samples.length;
      if (this._samplesSinceFlush >= FLUSH_EVERY_SAMPLES && this._onFlush) {
        this._samplesSinceFlush = 0;
        const ecg = this.drainEcg();
        const acc = this.drainAcc();
        Promise.resolve(this._onFlush(ecg, acc)).catch(console.warn);
      }
    } else if (bytes[0] === 0x02) {
      const samples = parseAccFrame(bytes);
      if (!samples.length) return;
      const frameNs = extractFrameTimestampNs(bytes);
      if (!this._sessionStartNs) {
        this._sessionStartNs = frameNs;
        this._sessionWallMs = Date.now();
      }
      const baseS = Number(frameNs - this._sessionStartNs) / 1e9;
      samples.forEach(({ x, y, z }, i) => {
        this._accBuffer.push({ t: baseS + i / ACC_FS, x, y, z });
      });
    }
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._setStatus('error', 'Не удалось восстановить соединение с Polar H10');
      return;
    }

    const delay = RECONNECT_DELAYS_MS[
      Math.min(this._reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)
    ];
    this._reconnectAttempts++;
    this._setStatus('reconnecting');

    this._reconnectTimer = setTimeout(() => {
      if (!this._stopped) this._connect();
    }, delay);
  }
}

export const polarService = new PolarService();

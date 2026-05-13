import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State } from 'react-native-ble-plx';
import {
  PMD_SERVICE, PMD_CONTROL, PMD_DATA,
  ECG_START, ECG_STOP,
  bytesToBase64, base64ToBytes, parseEcgFrame,
} from './polarProtocol';

const SAMPLE_RATE = 130;
const SCAN_TIMEOUT_MS = 12000;

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

// status: 'idle' | 'scanning' | 'connecting' | 'streaming' | 'error'
export function usePolarH10() {
  const [status, setStatus]         = useState('idle');
  const [errorMsg, setErrorMsg]     = useState(null);
  const [deviceName, setDeviceName] = useState(null);
  const [sampleCount, setSampleCount] = useState(0); // debug: total samples received

  const managerRef    = useRef(null);
  const deviceRef     = useRef(null);
  const dataSubRef    = useRef(null);
  const ctrlSubRef    = useRef(null);
  const scanTimerRef  = useRef(null);
  const bufferRef     = useRef([]);
  const timeRef       = useRef(0);
  const sampleAccRef  = useRef(0); // accumulator between setSampleCount calls

  useEffect(() => {
    managerRef.current = new BleManager();
    return () => {
      _cleanup();
      managerRef.current?.destroy();
    };
  }, []);

  const _cleanup = () => {
    clearTimeout(scanTimerRef.current);
    managerRef.current?.stopDeviceScan();
    ctrlSubRef.current?.remove();
    ctrlSubRef.current = null;
    dataSubRef.current?.remove();
    dataSubRef.current = null;
  };

  const start = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager) return;

    setErrorMsg(null);
    setDeviceName(null);
    setSampleCount(0);
    sampleAccRef.current = 0;
    bufferRef.current = [];
    timeRef.current = 0;

    const bleState = await manager.state();
    if (bleState !== State.PoweredOn) {
      setStatus('error');
      setErrorMsg('Bluetooth выключен — включите и попробуйте снова');
      return;
    }

    const hasPerms = await requestBlePermissions();
    if (!hasPerms) {
      setStatus('error');
      setErrorMsg('Нет разрешений Bluetooth');
      return;
    }

    setStatus('scanning');

    scanTimerRef.current = setTimeout(() => {
      manager.stopDeviceScan();
      setStatus('error');
      setErrorMsg('Polar H10 не найден. Убедитесь что устройство включено и рядом.');
    }, SCAN_TIMEOUT_MS);

    manager.startDeviceScan(null, { allowDuplicates: false }, async (err, device) => {
      if (err) {
        clearTimeout(scanTimerRef.current);
        setStatus('error');
        setErrorMsg(err.message);
        return;
      }
      if (!device?.name?.toLowerCase().includes('polar')) return;

      clearTimeout(scanTimerRef.current);
      manager.stopDeviceScan();
      setDeviceName(device.name);
      setStatus('connecting');

      try {
        const connected = await device.connect({ autoConnect: false });
        await connected.discoverAllServicesAndCharacteristics();
        await connected.requestMTU(232); // Polar H10 ECG requires MTU >= 232
        deviceRef.current = connected;

        // Monitor PMD_CONTROL to catch the response to ECG_START.
        // Response: [0xF0, op=0x02, type=0x00, error_code]
        // error_code 0x00 = success; anything else = failure.
        ctrlSubRef.current = connected.monitorCharacteristicForService(
          PMD_SERVICE, PMD_CONTROL,
          (ctrlErr, char) => {
            if (ctrlErr || !char?.value) return;
            const bytes = base64ToBytes(char.value);
            if (bytes[0] === 0xF0 && bytes[3] !== 0x00) {
              setStatus('error');
              setErrorMsg(`Polar ECG start failed (code 0x${bytes[3].toString(16).toUpperCase()})`);
            }
          },
        );

        // Monitor PMD_DATA for ECG frames
        dataSubRef.current = connected.monitorCharacteristicForService(
          PMD_SERVICE, PMD_DATA,
          (notifyErr, char) => {
            if (notifyErr) {
              setErrorMsg(`BLE notify error: ${notifyErr.message}`);
              return;
            }
            if (!char?.value) return;
            const bytes = base64ToBytes(char.value);
            const samples = parseEcgFrame(bytes);
            if (samples.length === 0) return;
            samples.forEach((uV) => {
              timeRef.current += 1 / SAMPLE_RATE;
              bufferRef.current.push({ x: timeRef.current, y: uV * 1e-3 }); // µV → mV
            });
            // Update debug counter every ~65 samples (~0.5 sec) to avoid re-render spam
            sampleAccRef.current += samples.length;
            if (sampleAccRef.current >= 65) {
              setSampleCount((n) => n + sampleAccRef.current);
              sampleAccRef.current = 0;
            }
          },
        );

        await connected.writeCharacteristicWithResponseForService(
          PMD_SERVICE, PMD_CONTROL, bytesToBase64(ECG_START),
        );

        setStatus('streaming');
      } catch (e) {
        setStatus('error');
        setErrorMsg(e.message);
      }
    });
  }, []);

  const stop = useCallback(async () => {
    _cleanup();
    const device = deviceRef.current;
    if (device) {
      try {
        const isConn = await device.isConnected();
        if (isConn) {
          await device.writeCharacteristicWithResponseForService(
            PMD_SERVICE, PMD_CONTROL, bytesToBase64(ECG_STOP),
          );
          await device.cancelConnection();
        }
      } catch (_) {}
      deviceRef.current = null;
    }
    bufferRef.current = [];
    timeRef.current = 0;
    setStatus('idle');
    setDeviceName(null);
    setSampleCount(0);
    setErrorMsg(null);
  }, []);

  const drainSamples = useCallback(() => {
    const pts = bufferRef.current;
    bufferRef.current = [];
    return pts;
  }, []);

  return { bleStatus: status, bleError: errorMsg, deviceName, sampleCount, startBle: start, stopBle: stop, drainSamples };
}

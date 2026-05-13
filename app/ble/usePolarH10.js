import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State } from 'react-native-ble-plx';
import {
  PMD_SERVICE, PMD_CONTROL, PMD_DATA,
  ECG_START, ECG_STOP,
  ACC_FS, ACC_START, ACC_STOP,
  bytesToBase64, base64ToBytes,
  parseEcgFrame, parseAccFrame, extractFrameTimestampNs,
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
  const bufferRef          = useRef([]);
  const accBufferRef       = useRef([]);
  const sessionStartNsRef  = useRef(null); // BigInt, device ns of first frame
  const sessionWallMsRef   = useRef(null); // Date.now() when sessionStartNs was set
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
    accBufferRef.current = [];
    sessionStartNsRef.current = null;
    sessionWallMsRef.current  = null;

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
              const mtype = bytes[2]; // 0x00=ECG, 0x02=ACC
              const code  = bytes[3].toString(16).toUpperCase();
              if (mtype === 0x00) {
                setStatus('error');
                setErrorMsg(`ECG start failed (code 0x${code})`);
              } else {
                // ACC error — keep ECG running, just warn
                console.warn(`ACC start failed (code 0x${code}) — accelerometer disabled`);
              }
            }
          },
        );

        // Monitor PMD_DATA for ECG and ACC frames (dispatched by byte[0])
        dataSubRef.current = connected.monitorCharacteristicForService(
          PMD_SERVICE, PMD_DATA,
          (notifyErr, char) => {
            if (notifyErr) {
              setErrorMsg(`BLE notify error: ${notifyErr.message}`);
              return;
            }
            if (!char?.value) return;
            const bytes = base64ToBytes(char.value);

            if (bytes[0] === 0x00) {
              // ECG frame
              const samples = parseEcgFrame(bytes);
              if (samples.length === 0) return;
              const frameNs = extractFrameTimestampNs(bytes);
              if (sessionStartNsRef.current === null) {
                sessionStartNsRef.current = frameNs;
                sessionWallMsRef.current  = Date.now();
              }
              const baseS = Number(frameNs - sessionStartNsRef.current) / 1e9;
              samples.forEach((uV, i) => {
                bufferRef.current.push({ x: baseS + i / SAMPLE_RATE, y: uV * 1e-3 });
              });
              sampleAccRef.current += samples.length;
              if (sampleAccRef.current >= 65) {
                setSampleCount((n) => n + sampleAccRef.current);
                sampleAccRef.current = 0;
              }
            } else if (bytes[0] === 0x02) {
              // ACC frame
              const samples = parseAccFrame(bytes);
              if (samples.length === 0) return;
              const frameNs = extractFrameTimestampNs(bytes);
              if (sessionStartNsRef.current === null) {
                sessionStartNsRef.current = frameNs;
                sessionWallMsRef.current  = Date.now();
              }
              const baseS = Number(frameNs - sessionStartNsRef.current) / 1e9;
              samples.forEach(({ x, y, z }, i) => {
                accBufferRef.current.push({ t: baseS + i / ACC_FS, x, y, z });
              });
            }
          },
        );

        await connected.writeCharacteristicWithResponseForService(
          PMD_SERVICE, PMD_CONTROL, bytesToBase64(ECG_START),
        );
        // Small delay so the device finishes processing ECG start before ACC start
        await new Promise((r) => setTimeout(r, 300));
        await connected.writeCharacteristicWithResponseForService(
          PMD_SERVICE, PMD_CONTROL, bytesToBase64(ACC_START),
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
          await device.writeCharacteristicWithResponseForService(
            PMD_SERVICE, PMD_CONTROL, bytesToBase64(ACC_STOP),
          );
          await device.cancelConnection();
        }
      } catch (_) {}
      deviceRef.current = null;
    }
    bufferRef.current = [];
    accBufferRef.current = [];
    sessionStartNsRef.current = null;
    sessionWallMsRef.current  = null;
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

  const drainAccSamples = useCallback(() => {
    const pts = accBufferRef.current;
    accBufferRef.current = [];
    return pts;
  }, []);

  // Returns elapsed seconds since the first BLE frame of this session (wall-clock based).
  const getSessionElapsed = useCallback(() => {
    if (sessionWallMsRef.current === null) return 0;
    return (Date.now() - sessionWallMsRef.current) / 1000;
  }, []);

  return { bleStatus: status, bleError: errorMsg, deviceName, sampleCount, startBle: start, stopBle: stop, drainSamples, drainAccSamples, getSessionElapsed };
}

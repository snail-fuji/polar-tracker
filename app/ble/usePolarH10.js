import { useCallback, useEffect, useState } from 'react';
import { polarService } from './PolarService';

export function usePolarH10() {
  const [snapshot, setSnapshot] = useState(() => polarService.getSnapshot());
  const [sampleCount, setSampleCount] = useState(0);

  useEffect(() => {
    return polarService.subscribe(setSnapshot);
  }, []);

  const startBle = useCallback(async () => {
    setSampleCount(0);
    await polarService.start();
  }, []);

  const stopBle = useCallback(async () => {
    await polarService.stop();
    setSampleCount(0);
  }, []);

  const drainSamples = useCallback(() => {
    const pts = polarService.drainEcg();
    if (pts.length > 0) setSampleCount((n) => n + pts.length);
    return pts;
  }, []);

  const drainAccSamples = useCallback(() => polarService.drainAcc(), []);

  const getSessionElapsed = useCallback(() => polarService.getSessionElapsed(), []);

  return {
    bleStatus: snapshot.status,
    bleError: snapshot.errorMsg,
    deviceName: snapshot.deviceName,
    sampleCount,
    startBle,
    stopBle,
    drainSamples,
    drainAccSamples,
    getSessionElapsed,
  };
}

// Polar Measurement Data (PMD) service — same UUIDs as in bleakheart
export const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
export const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
export const PMD_DATA    = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

// START_MEASUREMENT (0x02), ECG type (0x00),
// SAMPLE_RATE = 130 Hz, RESOLUTION = 14 bit
export const ECG_START = [0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00];
export const ECG_STOP  = [0x03, 0x00];

export function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

export function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Parse a raw ECG notification frame.
// Frame layout (matches Polar Open SDK + what bleakheart reads):
//   [0]      measurement type  (0x00 = ECG)
//   [1..8]   timestamp ns      (uint64 LE — we ignore, use wall clock instead)
//   [9]      frame type        (0x00 = raw)
//   [10+]    samples           (3 bytes each, signed int24 LE, in µV)
//
// Returns array of sample values in µV.
export function parseEcgFrame(bytes) {
  if (bytes.length < 10) return [];
  if (bytes[0] !== 0x00) return []; // not ECG
  if (bytes[9] !== 0x00) return []; // not raw frame

  const samples = [];
  for (let i = 10; i + 2 < bytes.length; i += 3) {
    let v = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
    if (v & 0x800000) v -= 0x1000000; // two's complement sign extend
    samples.push(v); // µV
  }
  return samples;
}

import { useMemo } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';

const HEIGHT  = 180;
const PAD     = { top: 10, right: 10, bottom: 30, left: 50 };
const X_TICKS = 5;
const Y_TICKS = 4;

export default function AccGraph({ data }) {
  const { width } = useWindowDimensions();
  const w      = width - 32;
  const innerW = w - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const axisY  = PAD.top + innerH;

  const xMin = data.length > 1 ? data[0].x : 0;
  const xMax = data.length > 1 ? data[data.length - 1].x : 1;
  const xSpan = xMax - xMin || 1;

  const { yMin, yMax } = useMemo(() => {
    if (data.length < 2) return { yMin: 0, yMax: 1 };
    let lo = Infinity, hi = -Infinity;
    for (const { y } of data) { if (y < lo) lo = y; if (y > hi) hi = y; }
    const margin = (hi - lo) * 0.1 || 50;
    return { yMin: lo - margin, yMax: hi + margin };
  }, [data]);
  const ySpan = yMax - yMin || 1;

  const sx = (x) => PAD.left  + ((x - xMin) / xSpan) * innerW;
  const sy = (y) => PAD.top   + (1 - (y - yMin) / ySpan) * innerH;

  const points = useMemo(
    () => data.map(({ x, y }) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' '),
    [data], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const xTickVals = useMemo(
    () => Array.from({ length: X_TICKS }, (_, i) => xMin + (i / (X_TICKS - 1)) * xSpan),
    [xMin, xSpan],
  );
  const yTickVals = useMemo(
    () => Array.from({ length: Y_TICKS }, (_, i) => yMin + (i / (Y_TICKS - 1)) * ySpan),
    [yMin, ySpan],
  );

  if (data.length < 2) {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.hint}>Нет данных акселерометра</Text>
      </View>
    );
  }

  return (
    <Svg width={w} height={HEIGHT}>
      <Rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="#f9fafb" />

      {yTickVals.map((yv) => (
        <Line key={yv}
          x1={PAD.left} y1={sy(yv)} x2={PAD.left + innerW} y2={sy(yv)}
          stroke="#f3f4f6" strokeWidth={1} />
      ))}

      <Polyline points={points} fill="none" stroke="#8b5cf6" strokeWidth={1.5} />

      <Line x1={PAD.left} y1={axisY} x2={PAD.left + innerW} y2={axisY}
        stroke="#d1d5db" strokeWidth={1} />
      <Line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={axisY}
        stroke="#d1d5db" strokeWidth={1} />

      {xTickVals.map((xv) => (
        <SvgText key={xv} x={sx(xv)} y={axisY + 14}
          fontSize={9} fill="#9ca3af" textAnchor="middle">
          {xv.toFixed(1)}s
        </SvgText>
      ))}

      {yTickVals.map((yv) => (
        <SvgText key={yv} x={PAD.left - 6} y={sy(yv) + 4}
          fontSize={9} fill="#9ca3af" textAnchor="end">
          {Math.round(yv)}
        </SvgText>
      ))}

      <SvgText x={PAD.left - 36} y={PAD.top + innerH / 2}
        fontSize={9} fill="#9ca3af" textAnchor="middle"
        rotation="-90" originX={PAD.left - 36} originY={PAD.top + innerH / 2}>
        mG
      </SvgText>
    </Svg>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    height: HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    borderRadius: 8,
  },
  hint: { fontSize: 13, color: '#9ca3af' },
});

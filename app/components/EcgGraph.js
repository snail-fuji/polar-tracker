import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import {
  VictoryAxis,
  VictoryChart,
  VictoryLine,
  VictoryZoomContainer,
} from 'victory-native';

const GRAPH_HEIGHT = 200;

export default function EcgGraph({ data }) {
  const { width } = useWindowDimensions();
  const chartWidth = width - 32;

  if (data.length < 2) {
    return (
      <View style={[styles.placeholder, { width: chartWidth, height: GRAPH_HEIGHT }]}>
        <Text style={styles.placeholderText}>Нет данных — нажмите Start recording</Text>
      </View>
    );
  }

  const xMin = data[0].x;
  const xMax = data[data.length - 1].x;

  return (
    <View style={styles.container}>
      <VictoryChart
        width={chartWidth}
        height={GRAPH_HEIGHT}
        padding={{ left: 46, right: 10, top: 10, bottom: 36 }}
        domain={{ x: [xMin, xMax], y: [-0.5, 1.3] }}
        containerComponent={<VictoryZoomContainer zoomDimension="x" />}
      >
        <VictoryAxis
          style={{
            axis: { stroke: '#d1d5db' },
            tickLabels: { fontSize: 10, fill: '#9ca3af' },
          }}
          tickFormat={(t) => `${t.toFixed(1)}s`}
          tickCount={5}
        />
        <VictoryAxis
          dependentAxis
          style={{
            axis: { stroke: '#d1d5db' },
            tickLabels: { fontSize: 10, fill: '#9ca3af' },
            grid: { stroke: '#f3f4f6', strokeWidth: 1 },
          }}
          tickCount={4}
        />
        <VictoryLine
          data={data}
          style={{ data: { stroke: '#16a34a', strokeWidth: 1.5 } }}
          interpolation="linear"
        />
      </VictoryChart>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  placeholder: {
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: { color: '#9ca3af', fontSize: 13 },
});

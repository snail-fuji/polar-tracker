import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import {
  VictoryChart,
  VictoryLine,
  VictoryAxis,
  VictoryZoomContainer,
} from 'victory-native';

export default function AccGraph({ data }) {
  const { width } = useWindowDimensions();

  if (data.length < 2) {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.hint}>Нет данных акселерометра</Text>
      </View>
    );
  }

  return (
    <VictoryChart
      width={width - 32}
      height={180}
      padding={{ top: 10, bottom: 30, left: 50, right: 10 }}
      containerComponent={<VictoryZoomContainer zoomDimension="x" />}
    >
      <VictoryAxis
        label="t, s"
        style={{
          axisLabel: { fontSize: 9, fill: '#9ca3af', padding: 18 },
          tickLabels: { fontSize: 9, fill: '#9ca3af' },
        }}
      />
      <VictoryAxis
        dependentAxis
        label="|a|, mG"
        style={{
          axisLabel: { fontSize: 9, fill: '#9ca3af', padding: 36 },
          tickLabels: { fontSize: 9, fill: '#9ca3af' },
        }}
      />
      <VictoryLine
        data={data}
        style={{ data: { stroke: '#8b5cf6', strokeWidth: 1.5 } }}
        interpolation="linear"
      />
    </VictoryChart>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    height: 180,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    borderRadius: 8,
  },
  hint: { fontSize: 13, color: '#9ca3af' },
});

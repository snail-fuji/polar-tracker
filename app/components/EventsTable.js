import { FlatList, StyleSheet, Text, View } from 'react-native';

const STRESS_COLORS = {
  High: { color: '#ef4444', bg: '#fee2e2' },
  Med:  { color: '#eab308', bg: '#fef9c3' },
  Low:  { color: '#22c55e', bg: '#dcfce7' },
};

function formatElapsed(s) {
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export default function EventsTable({ events }) {
  if (events.length === 0) {
    return <Text style={styles.empty}>Событий пока нет</Text>;
  }

  return (
    <View style={styles.table}>
      <View style={[styles.row, styles.header]}>
        <Text style={[styles.cellTime, styles.headerText]}>t (m:ss)</Text>
        <Text style={[styles.cellStress, styles.headerText]}>Stress</Text>
        <Text style={[styles.cellDesc, styles.headerText]}>Description</Text>
      </View>
      <FlatList
        data={[...events].reverse()}
        keyExtractor={(item) => String(item.id)}
        scrollEnabled={false}
        renderItem={({ item, index }) => {
          const s = STRESS_COLORS[item.stress] ?? STRESS_COLORS.Med;
          return (
            <View style={[styles.row, index % 2 === 0 && styles.rowAlt]}>
              <Text style={styles.cellTime}>{formatElapsed(item.timeS ?? 0)}</Text>
              <View style={styles.cellStress}>
                <View style={[styles.stressBadge, { backgroundColor: s.bg }]}>
                  <Text style={[styles.stressBadgeText, { color: s.color }]}>{item.stress}</Text>
                </View>
              </View>
              <Text style={styles.cellDesc} numberOfLines={2}>{item.description}</Text>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  table: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderTopWidth: 1,
    borderColor: '#f3f4f6',
  },
  rowAlt: { backgroundColor: '#f9fafb' },
  header: { backgroundColor: '#f3f4f6', borderTopWidth: 0 },
  headerText: { fontWeight: '600', color: '#374151', fontSize: 13 },
  cellTime: { width: 82, fontSize: 13, color: '#374151', fontVariant: ['tabular-nums'] },
  cellStress: { width: 54, alignItems: 'flex-start' },
  cellDesc: { flex: 1, fontSize: 13, color: '#374151' },
  stressBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
  },
  stressBadgeText: { fontSize: 12, fontWeight: '700' },
  empty: { color: '#9ca3af', fontSize: 13, fontStyle: 'italic', paddingVertical: 4 },
});

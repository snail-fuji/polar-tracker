import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

const STRESS_LEVELS = [
  { label: 'High', color: '#ef4444', bg: '#fee2e2' },
  { label: 'Med',  color: '#eab308', bg: '#fef9c3' },
  { label: 'Low',  color: '#22c55e', bg: '#dcfce7' },
];

export default function AddEventModal({ visible, onConfirm, onCancel }) {
  const [description, setDescription] = useState('');
  const [stress, setStress] = useState(null);

  const handleConfirm = () => {
    onConfirm({
      description: description.trim() || '(без описания)',
      stress: stress ?? 'Med',
    });
    setDescription('');
    setStress(null);
  };

  const handleCancel = () => {
    setDescription('');
    setStress(null);
    onCancel();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleCancel}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={styles.dialog}>
            <Text style={styles.title}>Новое событие</Text>

            {/* Stress selector */}
            <View style={styles.stressRow}>
              {STRESS_LEVELS.map((s) => {
                const selected = stress === s.label;
                return (
                  <TouchableOpacity
                    key={s.label}
                    style={[
                      styles.stressBtn,
                      { backgroundColor: s.bg, borderColor: s.color },
                      selected && styles.stressBtnSelected,
                    ]}
                    onPress={() => setStress(s.label)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.stressBtnText, { color: s.color }]}>{s.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TextInput
              style={styles.input}
              placeholder="Enter description..."
              placeholderTextColor="#9ca3af"
              value={description}
              onChangeText={setDescription}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleConfirm}
            />

            <View style={styles.buttons}>
              <TouchableOpacity style={styles.btnCancel} onPress={handleCancel}>
                <Text style={styles.btnCancelText}>Отмена</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnOk} onPress={handleConfirm}>
                <Text style={styles.btnOkText}>OK</Text>
              </TouchableOpacity>
            </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-start',
    paddingHorizontal: 32,
    paddingTop: 56,
  },
  dialog: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 20,
    gap: 16,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
  },
  title: { fontSize: 17, fontWeight: '600', color: '#111827' },

  stressRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  stressBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 50,
    borderWidth: 2,
    alignItems: 'center',
    opacity: 0.18,
  },
  stressBtnSelected: { opacity: 1 },
  stressBtnText: { fontSize: 15, fontWeight: '700' },

  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    color: '#111827',
  },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  btnCancel: {
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  btnCancelText: { fontSize: 15, color: '#6b7280' },
  btnOk: {
    paddingVertical: 9,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#4f46e5',
  },
  btnOkText: { fontSize: 15, color: '#fff', fontWeight: '600' },
});

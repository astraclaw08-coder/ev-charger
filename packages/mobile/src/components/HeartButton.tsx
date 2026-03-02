import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';

interface Props {
  isFavorited: boolean;
  onToggle: () => void;
  size?: number;
}

export function HeartButton({ isFavorited, onToggle, size = 22 }: Props) {
  return (
    <TouchableOpacity onPress={onToggle} style={styles.btn} hitSlop={8}>
      <Text style={{ fontSize: size }}>{isFavorited ? '❤️' : '🤍'}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: { padding: 4 },
});

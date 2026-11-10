import { localDayBounds } from './localDayBounds.mjs';

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const january = localDayBounds('2024-01-15', '2024-01-15');
assertEqual(january.from, '2024-01-15T08:00:00.000Z', 'January midnight PST');
assertEqual(january.toExclusive, '2024-01-16T08:00:00.000Z', 'January next midnight PST');

const july = localDayBounds('2024-07-15', '2024-07-15');
assertEqual(july.from, '2024-07-15T07:00:00.000Z', 'July midnight PDT');
assertEqual(july.toExclusive, '2024-07-16T07:00:00.000Z', 'July next midnight PDT');

const transition = localDayBounds('2024-03-10', '2024-03-10');
assertEqual(transition.from, '2024-03-10T08:00:00.000Z', 'DST-start midnight');
assertEqual(transition.toExclusive, '2024-03-11T07:00:00.000Z', 'DST-start next midnight');

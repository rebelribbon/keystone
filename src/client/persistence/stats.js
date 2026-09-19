// Per-chunk timing summaries (ticket 005 §5).
//
// Totals hid the load-path defect for a whole ticket: 518.9 s reads as "slow
// network" until you divide by 70 and see 7.4 s a chunk against 0.97 s going
// the other way. Per-chunk figures are what made it diagnosable, so they are
// what the gate harness reports.

/**
 * Min, median and max of a list of measurements.
 *
 * Median rather than mean: one cold start or one evicted chunk should not move
 * the number that gets compared against the save path.
 * @param {number[]} values
 * @returns {{count: number, min: number, median: number, max: number}}
 */
export function summarize(values) {
  const list = (values || []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!list.length) return { count: 0, min: 0, median: 0, max: 0 };
  const mid = Math.floor(list.length / 2);
  return {
    count: list.length,
    min: list[0],
    median: list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2,
    max: list[list.length - 1],
  };
}

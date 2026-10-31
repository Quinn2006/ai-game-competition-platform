// Prototype arithmetic only. Ranking scope, ties and invalidation remain T-06/T-17.
function bounded(value, max = 100) {
  if (!Number.isFinite(value) || value < 0 || value > max) throw new RangeError('Invalid score/count');
  return value;
}
export function judgeScore(values) {
  if (!Array.isArray(values) || values.length !== 5) throw new TypeError('Five criteria required');
  return values.reduce((sum, value, i) => sum + bounded(value) * [25, 25, 20, 15, 15][i], 0) / 100;
}
export function judgeAverage(judges) {
  if (!Array.isArray(judges) || judges.length < 3) throw new RangeError('At least three valid judges required');
  return judges.reduce((sum, values) => sum + judgeScore(values), 0) / judges.length;
}
export function popularity(likes, plays, maxLikes, maxPlays) {
  for (const n of [likes, plays, maxLikes, maxPlays]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Counts must be nonnegative safe integers');
  }
  if (likes > maxLikes || plays > maxPlays) throw new RangeError('Snapshot maximum inconsistent');
  return (maxLikes ? likes / maxLikes * 60 : 0) + (maxPlays ? plays / maxPlays * 40 : 0);
}
export function finalScore(average, popular) {
  return (bounded(average) * 60 + bounded(popular) * 40) / 100;
}
export function displayScore(score) { return bounded(score).toFixed(2); }

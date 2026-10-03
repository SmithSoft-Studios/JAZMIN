// Helpers for sorted, de-duplicated arrays of row ids.

export function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return out;
}

export function unionAll(lists) {
  if (lists.length === 0) return [];
  if (lists.length === 1) return lists[0];
  let total = 0;
  for (const list of lists) total += list.length;
  const all = new Float64Array(total);
  let pos = 0;
  for (const list of lists) {
    all.set(list, pos);
    pos += list.length;
  }
  all.sort();
  const out = [];
  for (let i = 0; i < all.length; i++) if (i === 0 || all[i] !== all[i - 1]) out.push(all[i]);
  return out;
}

/** Local midnight for one calendar day, using that date's own DST offset. */
export function localDayBounds(fromDay, toDay) {
  return {
    from: fromDay ? instantAtLocalMidnight(fromDay, 0) : undefined,
    toExclusive: toDay ? instantAtLocalMidnight(toDay, 1) : undefined,
  };
}

function instantAtLocalMidnight(day, addDays) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date + addDays).toISOString();
}

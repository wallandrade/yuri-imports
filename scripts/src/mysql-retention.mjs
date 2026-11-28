// Deletes only MySQL dumps under mysql/ that are older than 30 days.
// A media key never matches. Used by the dump job without loading TypeScript.

export const MYSQL_CLEANUP_DAYS = 30;
const DUMP_KEY = /^mysql\/(\d{4}-\d{2}-\d{2})_\d{4}\.sql\.gz$/;

export function addCalendarDays(day, delta) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("dia inválido");
  const [year, month, date] = day.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() + delta);
  const yyyy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function calendarDay(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Keys strictly older than 30 days. The cutoff day stays. Anything outside mysql/*.sql.gz stays. */
export function mysqlDumpKeysToDelete(keys, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("dia inválido");
  const cutoff = addCalendarDays(today, -MYSQL_CLEANUP_DAYS);
  const expired = [];
  for (const key of keys) {
    if (typeof key !== "string" || key.includes("..") || key.includes("media")) continue;
    const match = DUMP_KEY.exec(key);
    if (!match) continue;
    if (match[1] < cutoff) expired.push(key);
  }
  return expired;
}

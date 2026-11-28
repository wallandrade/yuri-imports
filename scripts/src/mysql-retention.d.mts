export const MYSQL_CLEANUP_DAYS: 30;

export function addCalendarDays(day: string, delta: number): string;

export function calendarDay(date: Date, timeZone: string): string;

export function mysqlDumpKeysToDelete(keys: readonly string[], today: string): string[];

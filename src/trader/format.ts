/**
 * French formatting for everything the owner reads (project rule:
 * operator-facing output in French, in their time zone). No state, no I/O.
 */

export const DEFAULT_TIME_ZONE = "Europe/Paris";

export function fmtEur(value: number, digits = 2): string {
  return `${value.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits })} €`;
}

export function fmtUsdCents(cents: number): string {
  return `${cents < 0 ? "-" : ""}${(Math.abs(cents) / 100).toFixed(2).replace(".", ",")} $`;
}

export function fmtPct(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}

/** "mer. 8 oct. 00:12" in the owner's time zone. */
export function fmtWhen(iso: string, tz = DEFAULT_TIME_ZONE): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("fr-FR", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    .replace(",", "").replace(" à ", " ");
}

/** "00:12" in the owner's time zone. */
export function fmtTime(iso: string, tz = DEFAULT_TIME_ZONE): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
}

/** "mercredi 7 octobre" in the owner's time zone. */
export function fmtDayLong(date: Date, tz = DEFAULT_TIME_ZONE): string {
  return date.toLocaleDateString("fr-FR", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
}

/** "7 oct." for a YYYY-MM-DD day (a calendar day has no time zone). */
export function fmtDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("fr-FR", { timeZone: "UTC", day: "numeric", month: "short" }).replace(",", "");
}

export function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} jours`;
}

/** "dans 3 h", "dans 2 jours". */
export function inTime(iso: string, now: Date): string {
  const minutes = Math.round((Date.parse(iso) - now.getTime()) / 60_000);
  if (minutes <= 0) return "maintenant";
  if (minutes < 60) return `dans ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `dans ${hours} h` : `dans ${Math.round(hours / 24)} jours`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n > 1 ? many : one}`;
}

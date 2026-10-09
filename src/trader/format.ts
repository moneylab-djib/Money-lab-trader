/**
 * French formatting for everything the owner reads (project rule:
 * operator-facing output in French, in their time zone). No state, no I/O.
 */

export const DEFAULT_TIME_ZONE = "Europe/Paris";

/** An amount in euros ("n.d." when code has no finite figure: never "∞ €" or "NaN €"). */
export function fmtEur(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "n.d.";
  return `${value.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits })} €`;
}

/**
 * Fraction digits that show a unit price below 1 EUR with at least 5 significant digits (step 0.3, owner's
 * choice of 2026-10-09: prices from 1 EUR keep their cents, smaller ones would read "0,00 €").
 */
function priceDigits(value: number): number {
  return Math.min(20, Math.max(2, 4 - Math.floor(Math.log10(Math.abs(value)))));
}

/** A unit price for the owner: "0,0048874 €" below 1 EUR, exactly fmtEur from 1 EUR; never an exponent. */
export function fmtPrice(value: number): string {
  if (!Number.isFinite(value)) return "n.d.";
  if (value === 0 || Math.abs(value) >= 1) return fmtEur(value);
  return `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: priceDigits(value) })} €`;
}

/**
 * A price echoed as stored or as the model typed it: every digit, never an exponent (String(7.7e-8) is
 * "7.7e-8"); exactly String(value) from 1 EUR.
 */
export function plainPrice(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value === 0 || Math.abs(value) >= 1) return String(value);
  return value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 12 });
}

/** A quantity as stored (decimal point, every digit, never an exponent); "n.d." for one a pre-0.3 fill left non-finite. */
export function qtyText(value: number | null): string {
  if (value === null) return "?";
  if (!Number.isFinite(value)) return "n.d.";
  return value !== 0 && Math.abs(value) < 1e-6 ? value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 12 }) : String(value);
}

/** A unit price for the model, in English without the unit: "0.0048874" below 1 EUR, exactly value.toFixed(2) from 1 EUR. */
export function priceEn(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value === 0 || Math.abs(value) >= 1) return value.toFixed(2);
  return value.toLocaleString("en-US", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: priceDigits(value) });
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

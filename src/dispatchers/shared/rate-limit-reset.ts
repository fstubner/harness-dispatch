/**
 * The reset time a CLI's own usage-limit message states, as seconds from now.
 *
 * Harnesses say when a limit lifts in prose, not in a header:
 *
 *   Codex:  "...or try again at Sep 26th, 2026 1:34 PM."   (machine-local time)
 *           "...or try again at 2:50 PM."                  (today, or tomorrow)
 *   Claude: "You've hit your session limit · resets 1:30am (Europe/Dublin)"
 *
 * Without this, a limited route tripped the breaker for the default 300 s and
 * the router came back to it every five minutes, spending ~40 s per attempt
 * learning what the provider had already said — up to five days ahead.
 *
 * Returns null when no stated time is found, or the stated time has passed;
 * the caller then keeps the default cooldown. The breaker caps whatever this
 * returns at 24 h, and a later attempt re-trips for the remainder.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * "try again at" / "reset(s) (at)", then an optional "<Mon> <day>[st|nd|rd|th][,] [<year>[,]]",
 * then "<h>[:<mm>] am|pm", then an optional "(<IANA zone>)".
 */
const STATED_RESET_RE =
  /\b(?:try again at|resets?(?:\s+at)?)\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/i;

interface WallTime {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number;
  minute: number;
}

/** The calendar date and time an instant shows in `zone` (machine-local when undefined). */
function wallTimeAt(epochMs: number, zone: string | undefined): WallTime {
  if (zone === undefined) {
    const d = new Date(epochMs);
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The instant a wall-clock time in `zone` names (machine-local when undefined). */
function epochOf(t: WallTime, zone: string | undefined): number {
  if (zone === undefined) return new Date(t.year, t.month, t.day, t.hour, t.minute).getTime();
  // Treat the wall time as UTC, then correct by the zone's offset at that
  // instant; a second pass settles a guess that landed across a DST change.
  const asUtc = Date.UTC(t.year, t.month, t.day, t.hour, t.minute);
  const offsetAt = (ms: number): number => {
    const w = wallTimeAt(ms, zone);
    return Date.UTC(w.year, w.month, w.day, w.hour, w.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  const first = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(first);
}

/** A zone name Intl accepts, else undefined (and machine-local time is used). */
function knownZone(zone: string | undefined): string | undefined {
  if (zone === undefined) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

export function statedResetSeconds(text: string, nowMs: number = Date.now()): number | null {
  const m = STATED_RESET_RE.exec(text);
  if (!m) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, ampm, zoneText] = m;
  const hour12 = Number(hourText);
  const minute = minuteText !== undefined ? Number(minuteText) : 0;
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (ampm!.toLowerCase() === "p" ? 12 : 0);
  const zone = knownZone(zoneText);
  const today = wallTimeAt(nowMs, zone);

  let target: number;
  if (monthName !== undefined) {
    const month = MONTHS.indexOf(monthName.toLowerCase().slice(0, 3));
    const day = Number(dayText);
    const year = yearText !== undefined ? Number(yearText) : today.year;
    target = epochOf({ year, month, day, hour, minute }, zone);
    // "Jan 2" read in late December means next year's.
    if (yearText === undefined && target <= nowMs) {
      target = epochOf({ year: year + 1, month, day, hour, minute }, zone);
    }
  } else {
    // A bare time is the next time the clock shows it: today, or tomorrow.
    target = epochOf({ ...today, hour, minute }, zone);
    if (target <= nowMs) {
      target = epochOf({ ...wallTimeAt(nowMs + 24 * 3_600_000, zone), hour, minute }, zone);
    }
  }
  const seconds = Math.round((target - nowMs) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

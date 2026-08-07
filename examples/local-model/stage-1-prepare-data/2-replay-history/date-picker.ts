/**
 * Pick a stratified set of past dates for historical replay.
 *
 * Strategy:
 *   - weekday    → 70 % of slots; one Mon-Thu per ISO week, rotating
 *   - week-end   → 15 % of slots; Fridays
 *   - week-start → 15 % of slots; Sundays
 *
 * Skips dates that are likely to have no Aula activity (weekends for weekday
 * prompt; Danish summer + Christmas holiday windows) — the model gains nothing
 * from training on empty data.
 *
 * Standalone CLI:
 *   bun run date-picker.ts --months 6 [--dry-run]
 */

export interface PickArgs {
  months: number;
  kinds: string[];
}

export interface Pick {
  kind: 'weekday' | 'week-end' | 'week-start';
  date: string; // ISO 8601 with time (set to 08:00 local Copenhagen as a stable hour)
}

const COPENHAGEN_OFFSET = '+02:00'; // good enough for replay; HA itself uses real TZ data

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isDanishHoliday(d: Date): boolean {
  const day = ymd(d);
  // Summer break ~ uge 27-32 in DK. Christmas break ~ Dec 20 - Jan 5.
  const month = d.getUTCMonth() + 1;
  const dom = d.getUTCDate();
  if (month === 7) return true;
  if (month === 8 && dom < 8) return true;
  if (month === 12 && dom >= 20) return true;
  if (month === 1 && dom <= 5) return true;
  // Påske / efterårsferie / vinterferie skipped roughly — fine-tune from
  // your local calendar if you find too many empty replays.
  return false;
}

function clampWeekday(d: Date): Date {
  // Mon=1..Sun=7. If weekend, slide back to nearest Thu.
  const day = d.getUTCDay() || 7;
  if (day === 6) d.setUTCDate(d.getUTCDate() - 2);
  if (day === 7) d.setUTCDate(d.getUTCDate() - 3);
  return d;
}

export async function pickDates(args: PickArgs): Promise<Pick[]> {
  const now = new Date();
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - args.months);

  const picks: Pick[] = [];
  const cursor = new Date(start);

  while (cursor < now) {
    const wd = cursor.getUTCDay();
    if (isDanishHoliday(cursor)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      continue;
    }

    if (args.kinds.includes('week-start') && wd === 0) {
      // Sunday
      picks.push({ kind: 'week-start', date: stamp(cursor) });
    } else if (args.kinds.includes('week-end') && wd === 5) {
      // Friday
      picks.push({ kind: 'week-end', date: stamp(cursor) });
    } else if (args.kinds.includes('weekday') && wd >= 1 && wd <= 4) {
      // Mon-Thu — only one per ISO week to avoid over-representation.
      const isoWeek = isoWeekKey(cursor);
      if (!picks.find((p) => p.kind === 'weekday' && isoWeekKey(new Date(p.date)) === isoWeek)) {
        picks.push({ kind: 'weekday', date: stamp(cursor) });
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return picks;
}

function stamp(d: Date): string {
  const day = ymd(d);
  return `${day}T08:00:00${COPENHAGEN_OFFSET}`;
}

function isoWeekKey(d: Date): string {
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// CLI entrypoint
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : def;
  };
  const dryRun = argv.includes('--dry-run');
  const picks = await pickDates({
    months: Number(get('--months', '6')),
    kinds: get('--kinds', 'weekday,week-end,week-start').split(','),
  });
  if (dryRun) {
    for (const p of picks) console.log(`${p.kind}\t${p.date}`);
    console.error(`Total: ${picks.length} picks`);
  } else {
    console.log(JSON.stringify(picks, null, 2));
  }
}

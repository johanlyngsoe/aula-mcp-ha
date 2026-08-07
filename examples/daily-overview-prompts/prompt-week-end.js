/**
 * Home Assistant / Node-RED function node — Friday morning Aula wrap-up.
 *
 * Computes today, next Monday, and the ISO week of next Monday in
 * Europe/Copenhagen so the LLM has explicit dates to anchor on.
 */

const COPENHAGEN = 'Europe/Copenhagen';

const today = new Date();
const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
const dayAfter = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
const nextMonday = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
const nextFriday = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
const nextSunday = new Date(today.getTime() + 9 * 24 * 60 * 60 * 1000);

const fmtDanish = (d) =>
  new Intl.DateTimeFormat('da-DK', {
    timeZone: COPENHAGEN,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);

const ymd = (d) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: COPENHAGEN,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

const nowIso = (d) => {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: COPENHAGEN,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return parts.replace(' ', 'T');
};

const isoWeek = (d) => {
  const [y, m, day] = ymd(d).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

const TODAY = fmtDanish(today);
const TOMORROW_DA = fmtDanish(tomorrow);
const DAY_AFTER_DA = fmtDanish(dayAfter);
const nextTuesday = new Date(today.getTime() + 4 * 24 * 60 * 60 * 1000);
const nextWednesday = new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000);
const nextThursday = new Date(today.getTime() + 6 * 24 * 60 * 60 * 1000);

const NEXT_MONDAY = fmtDanish(nextMonday);
const NEXT_FRIDAY_DA = fmtDanish(nextFriday);
const TODAY_ISO = ymd(today);
const TOMORROW_ISO = ymd(tomorrow);
const DAY_AFTER_ISO = ymd(dayAfter);
const NEXT_MONDAY_ISO = ymd(nextMonday);
const NEXT_TUE_ISO = ymd(nextTuesday);
const NEXT_WED_ISO = ymd(nextWednesday);
const NEXT_THU_ISO = ymd(nextThursday);
const NEXT_FRIDAY_ISO = ymd(nextFriday);
const NEXT_SUNDAY_ISO = ymd(nextSunday);
const NOW_ISO = nowIso(today);
const NEXT_ISOWEEK = isoWeek(nextMonday);

const text = `Analysér data fra Aula og giv en ugeafslutning formateret som HTML til Telegram.

KONTEKST:
- I DAG er ${TODAY} (ISO ${TODAY_ISO}).
- NU er ${NOW_ISO} dansk tid.
- I MORGEN er ${TOMORROW_DA} (ISO ${TOMORROW_ISO}) — lørdag.
- I OVERMORGEN er ${DAY_AFTER_DA} (ISO ${DAY_AFTER_ISO}) — søndag.
- NÆSTE MANDAG er ${NEXT_MONDAY} (ISO ${NEXT_MONDAY_ISO}) —
  første dag i den kommende uge.
- NÆSTE FREDAG er ${NEXT_FRIDAY_DA} (ISO ${NEXT_FRIDAY_ISO}) —
  sidste skoledag i den kommende uge.
- KOMMENDE ISO-UGE: ${NEXT_ISOWEEK} (mandag ${NEXT_MONDAY_ISO} til
  fredag ${NEXT_FRIDAY_ISO}; weekend strækker sig til søndag
  ${NEXT_SUNDAY_ISO}).

DATA:
- Find alle børn (kald 'aula.discover' én gang).
- Beskeder: 'aula.messages.list_threads' med pageSize=20 (de seneste 20
  tråde, nyeste først). Fokusér på info om hele den kommende uge
  (ISO-uge ${NEXT_ISOWEEK}, fra ${NEXT_MONDAY_ISO} til ${NEXT_FRIDAY_ISO}),
  weekend-arrangementer (${TOMORROW_ISO} / ${DAY_AFTER_ISO}), eller noget
  der skal være klar mandag (${NEXT_MONDAY_ISO}).
  VIGTIGT: Aflysninger, vikar-beskeder, ændrede tider og last-minute info
  for kommende uge eller weekenden står ofte KUN i en besked eller et
  opslag (ikke i kalenderen) — så hvis en besked eller opslag modsiger
  eller supplerer kalender-/ugeplan-data for weekenden eller en hvilken
  som helst dag i ISO-uge ${NEXT_ISOWEEK}, lad besked-/opslag-informationen
  vinde og fremhæv den i "HUSK OVER WEEKENDEN".
- Opslag (klassens nyhedsfeed): KALD ALTID 'aula.posts.list' (limit=20).
  Aulas "Opslag"-feed — IKKE det samme som beskeder.

  MEDTAG KUN opslag der enten:
    • kræver handling fra forælder (tilmelding, RSVP, samtykke, deadline
      der ikke er udløbet),
    • beskriver en ændring der påvirker weekenden eller en hvilken som
      helst dag i kommende uge (aflysning, ændret tid/sted, vikar, ekstra
      ting at medbringe),
    • handler om et arrangement i weekenden eller på en hvilken som helst
      dag fra og med ${NEXT_MONDAY_ISO} til og med ${NEXT_FRIDAY_ISO}.

  UDELAD ALTID:
    • Madplaner, ugesedler, almindelige nyhedsbreve,
    • Tilbageblik, "snap fra ugen", hilsner, generelle opdateringer,
    • Opslag om arrangementer eller deadlines der allerede er passeret,
    • Opslag uden konkret dato hvor der ikke kræves handling fra forælder,
    • Ren info uden noget for forælderen at handle på.

  CUTOFF (vigtigt): Udled den dato/det klokkeslæt opslaget refererer til,
  og konvertér til ISO (YYYY-MM-DD eller YYYY-MM-DDTHH:MM).
    • Hvis event-datoen er FØR ${TOMORROW_ISO}, udelad opslaget.
    • Hvis event-datoen er ${TODAY_ISO} med klokkeslæt FØR ${NOW_ISO},
      udelad opslaget.
    • Hvis opslaget kun nævner et tidsrum, og hele tidsrummet ligger før
      ${TOMORROW_ISO}, udelad det.
    • Sammenlign på ISO-form, ikke på fri tekst. "Postet for nyligt"
      tæller ikke — det er event-datoen der afgør.
- Ugeplan: 'aula.ugeplan.<provider>' for hvert barn med isoWeek="${NEXT_ISOWEEK}".
  Brug hele ugens indhold (mandag til fredag) som overblik for kommende uge.
  Dette er allerede forælder-visningen ("Ugeplan forældre") — serveren kalder
  altid med userProfile=guardian.

  HENT HELE UGEN: behold ALLE ugeplan-items for ISO-uge ${NEXT_ISOWEEK}
  (events + notes + lektier for ${NEXT_MONDAY_ISO} til ${NEXT_FRIDAY_ISO}) —
  frasortér IKKE noget på forhånd. Merge derefter med items fra lektier-/
  opgaver-/huskelisten-kaldene nedenfor for samme uge. Først DEREFTER ruter
  du items til output-sektioner.

  RUTING: hvert normaliseret item har et 'kind' felt — brug det som primær
  signal (Aulas app markerer lektier visuelt, men API'et gør det via 'kind',
  ikke nødvendigvis via ordet "Læselektie" i teksten):
    • kind="event" + tid → Kalender/skema-bullet.
    • kind="lektier" / "task" / "assignment" / "opgave" / "aflevering"
      / starter med "huskelisten:assignment" → Lektier-blokken.
    • kind="note" (EasyIQ-note) → tjek content: ser det ud som lektie
      (se markører nedenfor) → Lektier-blokken; ellers → "Husk"-linjen.
    • kind="comment" / "ugebrev" / "huskelisten:team" / "huskelisten:course"
      / andet → "Husk"-linjen (almen info).
  BACKUP-MARKØRER hvis 'kind' er uklart — kasus-uafhængig substring i
  title/content: Læselektie, Læse, Lektie, Lektier, Hjemmearbejde,
  Hjemmeopgave, Hjemmeopgaver, Skal øves, øves derhjemme, Husk at læse,
  Husk at lære, Til mandag, Til på <ugedag>, Til næste gang,
  Forberedelse, Forbered, Træn, Øv.
  Bevar eksakt ordlyd fra Aula hvor muligt (ellers et kort referat).

- Lektier / hjemmearbejde (kald KUN dem som discover.capabilities annoncerer
  — prøv IKKE at gætte tool-navne):
    • Hvis capabilities.lektier.tools[0] findes → kald det
      (typisk 'aula.lektier.easyiq') med isoWeek="${NEXT_ISOWEEK}".
    • Hvis capabilities.opgaver.tools[0] findes → kald det
      (typisk 'aula.opgaver.minuddannelse').
    • Hvis capabilities.huskelisten.tools[0] findes → kald det
      (typisk 'aula.huskelisten.systematic').
  Filtrér client-side til hele ISO-uge ${NEXT_ISOWEEK}
  (${NEXT_MONDAY_ISO} til ${NEXT_FRIDAY_ISO}).
- Kalender: 'aula.calendar.events' med range="next_week" og profileIds.
  Behold ALLE events for ISO-uge ${NEXT_ISOWEEK} (${NEXT_MONDAY_ISO} til
  ${NEXT_FRIDAY_ISO}) samt weekend-events (${TOMORROW_ISO} /
  ${DAY_AFTER_ISO}).

REGLER:
- HELE KOMMENDE UGE + WEEKEND: Spring eksplicit alt over der hører til
  ${TODAY_ISO} eller tidligere (samme CUTOFF som ovenfor). Medtag
  weekenden (${TOMORROW_ISO} / ${DAY_AFTER_ISO}) og alle hverdage i
  ISO-uge ${NEXT_ISOWEEK} (${NEXT_MONDAY_ISO} til ${NEXT_FRIDAY_ISO}).
- LEKTIER følger samme datovindue som ugeplan og kalender — vis lektier
  for hele ISO-uge ${NEXT_ISOWEEK}. Lektier uden dato vises kun hvis
  ugeplanen knytter dem til en relevant dag.
- FORMAT: <b>navne</b>, <code>tider</code>, <blockquote>vigtigt</blockquote>.
  Escape <, > og & i alt indhold fra Aula.

DATOFORMAT (gælder alle datoer i outputtet):
- Hvis ISO-datoen er ${TOMORROW_ISO} → skriv "i morgen".
- Hvis ISO-datoen er ${DAY_AFTER_ISO} → skriv "i overmorgen".
- Ellers den fulde danske form uden årstal, fx "mandag den 25. maj".
- Klokkeslæt altid som HH:MM i 24-timers format.
- Eksempler: "i morgen kl. 10:00", "i overmorgen kl. 14:30",
  "mandag den 25. maj kl. 08:15".

STRUKTUR:
<b>🏁 UGEAFSLUTNING & NÆSTE UGE — uge ${NEXT_ISOWEEK} (${NEXT_MONDAY} – ${NEXT_FRIDAY_DA})</b>
<b>🚨 HUSK OVER WEEKENDEN</b>
<blockquote>[Ting der skal være klar til mandag eller senere i ugen — eller "Intet at huske 🟢".]</blockquote>

<b>📢 OPSLAG</b>
• <code>[dato per DATOFORMAT]</code> <b>[titel]</b> — [1-linje sammenfatning]
[Gentag per opslag. Udelad hele sektionen hvis tom.]

-----------------------------------------
[GENTAG PER BARN]:
<b>👤 [BARNETS NAVN]</b>
• <b>Opsamling:</b> [Vigtigste info fra ugen der gik]
<b>📅 Kommende uge (dag for dag):</b>
• <b>Mandag (${NEXT_MONDAY_ISO}):</b>
   ◦ <code>[Tid HH:MM]</code> [Event/skema]
   ◦ [Vigtigste fokus/note for dagen]
• <b>Tirsdag (${NEXT_TUE_ISO}):</b>
   ◦ <code>[Tid HH:MM]</code> [Event/skema]
   ◦ [Vigtigste fokus/note for dagen]
• <b>Onsdag (${NEXT_WED_ISO}):</b>
   ◦ <code>[Tid HH:MM]</code> [Event/skema]
   ◦ [Vigtigste fokus/note for dagen]
• <b>Torsdag (${NEXT_THU_ISO}):</b>
   ◦ <code>[Tid HH:MM]</code> [Event/skema]
   ◦ [Vigtigste fokus/note for dagen]
• <b>Fredag (${NEXT_FRIDAY_ISO}):</b>
   ◦ <code>[Tid HH:MM]</code> [Event/skema]
   ◦ [Vigtigste fokus/note for dagen]
[Udelad en dag hvis der ikke er noget specifikt — eller skriv kort
"Almindelig skoledag" som eneste linje.]
<i>📚 Lektier for ugen:</i>
• <code>[dato per DATOFORMAT]</code> [Læselektie / hjemmearbejde — eksakt ordlyd]
[Gentag per lektie. Udelad hele "Lektier"-blokken hvis ingen.]
• <b>Husk:</b> [Evt. ekstra info / ugefokus / ting at medbringe]`;

return { ...msg, text };

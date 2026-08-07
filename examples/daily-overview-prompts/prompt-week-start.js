/**
 * Home Assistant / Node-RED function node — Sunday evening next-week kickoff.
 *
 * Computes today (Sunday) + tomorrow (Monday, first day of next ISO week)
 * in Europe/Copenhagen so the LLM has explicit dates to anchor on.
 */

const COPENHAGEN = 'Europe/Copenhagen';

const today = new Date();
const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
const dayAfter = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);
const wednesday = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
const thursday = new Date(today.getTime() + 4 * 24 * 60 * 60 * 1000);
const friday = new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000);

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
const TOMORROW = fmtDanish(tomorrow);
const DAY_AFTER_DA = fmtDanish(dayAfter);
const FRIDAY_DA = fmtDanish(friday);
const TODAY_ISO = ymd(today);
const TOMORROW_ISO = ymd(tomorrow);
const DAY_AFTER_ISO = ymd(dayAfter);
const WED_ISO = ymd(wednesday);
const THU_ISO = ymd(thursday);
const FRI_ISO = ymd(friday);
const NOW_ISO = nowIso(today);
const NEXT_ISOWEEK = isoWeek(tomorrow); // Monday is day 1 of next ISO week

const text = `Analysér data fra Aula og giv et ugeoverblik formateret som HTML til Telegram.

KONTEKST:
- I DAG er ${TODAY} (ISO ${TODAY_ISO}) — søndag, sidste dag i indeværende ISO-uge.
- NU er ${NOW_ISO} dansk tid.
- I MORGEN er ${TOMORROW} (ISO ${TOMORROW_ISO}) — mandag, første dag i
  ISO-uge ${NEXT_ISOWEEK}.
- I OVERMORGEN er ${DAY_AFTER_DA} (ISO ${DAY_AFTER_ISO}) — tirsdag.
- KOMMENDE UGE er ISO-uge ${NEXT_ISOWEEK}: mandag ${TOMORROW_ISO},
  tirsdag ${DAY_AFTER_ISO}, onsdag ${WED_ISO}, torsdag ${THU_ISO},
  fredag ${FRI_ISO} (${FRIDAY_DA}).

DATA:
- Find alle børn (kald 'aula.discover' én gang).
- Beskeder: 'aula.messages.list_threads' med pageSize=20 (de seneste 20
  tråde, nyeste først). Find vigtige deadlines og info for den kommende
  uge (ISO-uge ${NEXT_ISOWEEK}, fra og med ${TOMORROW_ISO}).
  VIGTIGT: Aflysninger, vikar-beskeder, ændrede tider og last-minute info
  for mandag eller resten af ugen står ofte KUN i en besked eller et
  opslag (ikke i kalenderen) — så hvis en besked eller opslag modsiger
  eller supplerer kalender-/ugeplan-data for ${TOMORROW_ISO} eller senere
  i ISO-uge ${NEXT_ISOWEEK}, lad besked-/opslag-informationen vinde og
  fremhæv den i "VIGTIGT & HANDLING".
- Opslag (klassens nyhedsfeed): KALD ALTID 'aula.posts.list' (limit=20).
  Aulas "Opslag"-feed — IKKE det samme som beskeder.

  MEDTAG KUN opslag der enten:
    • kræver handling fra forælder (tilmelding, RSVP, samtykke, deadline
      der ikke er udløbet),
    • beskriver en ændring der påvirker den kommende uge (aflysning,
      ændret tid/sted, vikar, ekstra ting at medbringe),
    • handler om et arrangement fra og med ${TOMORROW_ISO}.

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
  Brug hele ugens indhold som overblik.
  Dette er allerede forælder-visningen ("Ugeplan forældre") — serveren kalder
  altid med userProfile=guardian.

  HENT HELE UGEN: behold ALLE ugeplan-items for ISO-uge ${NEXT_ISOWEEK}
  (events + notes + lektier) — frasortér IKKE noget på forhånd. Merge
  derefter med items fra lektier-/opgaver-/huskelisten-kaldene nedenfor
  for samme uge. Først DEREFTER ruter du items til output-sektioner.

  RUTING: hvert normaliseret item har et 'kind' felt — brug det som primær
  signal (Aulas app markerer lektier visuelt, men API'et gør det via 'kind',
  ikke nødvendigvis via ordet "Læselektie" i teksten):
    • kind="event" + tid → Kalender/skema-bullet.
    • kind="lektier" / "task" / "assignment" / "opgave" / "aflevering"
      / starter med "huskelisten:assignment" → Lektier-blokken.
    • kind="note" (EasyIQ-note) → tjek content: ser det ud som lektie
      (se markører nedenfor) → Lektier-blokken; ellers → "Vigtigste
      lektie/fokus for ugen"-linjen.
    • kind="comment" / "ugebrev" / "huskelisten:team" / "huskelisten:course"
      / andet → fokus-linjen (almen info).
  BACKUP-MARKØRER hvis 'kind' er uklart — kasus-uafhængig substring i
  title/content: Læselektie, Læse, Lektie, Lektier, Hjemmearbejde,
  Hjemmeopgave, Hjemmeopgaver, Skal øves, øves derhjemme, Husk at læse,
  Husk at lære, Til i morgen, Til på <ugedag>, Til næste gang,
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
  Filtrér client-side til ISO-uge ${NEXT_ISOWEEK}.
- Kalender: 'aula.calendar.events' med range="tomorrow" og profileIds per barn.

REGLER:
- KUN ${TOMORROW_ISO} + KOMMENDE UGE: Spring eksplicit alt over der hører
  til ${TODAY_ISO} eller tidligere (samme CUTOFF som ovenfor).
- LEKTIER følger samme datovindue som ugeplan og kalender — vis kun lektier
  der hører til ISO-uge ${NEXT_ISOWEEK}. Lektier uden dato vises kun hvis
  ugeplanen knytter dem til en relevant dag.
- FORMAT: <b>fed</b> til navne, <code>kode</code> til tider, <blockquote> til vigtig info.
  Escape <, > og & i alt indhold fra Aula.

DATOFORMAT (gælder alle datoer i outputtet):
- Hvis ISO-datoen er ${TOMORROW_ISO} → skriv "i morgen".
- Hvis ISO-datoen er ${DAY_AFTER_ISO} → skriv "i overmorgen".
- Ellers den fulde danske form uden årstal, fx "torsdag den 28. maj".
- Klokkeslæt altid som HH:MM i 24-timers format.
- Eksempler: "i morgen kl. 08:15", "i overmorgen kl. 14:30",
  "torsdag den 28. maj kl. 10:00".

STRUKTUR:
<b>🚀 KLAR TIL EN NY UGE — i morgen, uge ${NEXT_ISOWEEK}</b>
<b>🚨 VIGTIGT & HANDLING</b>
<blockquote>[Kritiske ting for hele ugen. Hvis intet: <i>Ingen akutte ændringer 🟢</i>.]</blockquote>

<b>📢 OPSLAG</b>
• <code>[dato per DATOFORMAT]</code> <b>[titel]</b> — [1-linje sammenfatning]
[Gentag per opslag. Udelad hele sektionen hvis tom.]

-----------------------------------------
[GENTAG PER BARN]:
<b>👤 [BARNETS NAVN]</b>
<b>📧 Vigtigt fra beskeder:</b>
• [Kort opsummering] (<code>[dato per DATOFORMAT]</code>)
<b>📅 Kommende uge (dag for dag):</b>
• <b>Mandag (i morgen, ${TOMORROW_ISO}):</b>
   ◦ <code>[Tid HH:MM]</code> [Event/skema]
   ◦ [Vigtigste fokus/note for dagen]
• <b>Tirsdag (${DAY_AFTER_ISO}):</b>
   ◦ <code>[Tid HH:MM]</code> [Event/skema]
   ◦ [Vigtigste fokus/note for dagen]
• <b>Onsdag (${WED_ISO}):</b>
   ◦ <code>[Tid HH:MM]</code> [Event/skema]
   ◦ [Vigtigste fokus/note for dagen]
• <b>Torsdag (${THU_ISO}):</b>
   ◦ <code>[Tid HH:MM]</code> [Event/skema]
   ◦ [Vigtigste fokus/note for dagen]
• <b>Fredag (${FRI_ISO}):</b>
   ◦ <code>[Tid HH:MM]</code> [Event/skema]
   ◦ [Vigtigste fokus/note for dagen]
[Udelad en dag hvis der ikke er noget specifikt — eller skriv kort
"Almindelig skoledag" som eneste linje.]
<i>📚 Lektier for ugen:</i>
• <code>[dato per DATOFORMAT]</code> [Læselektie / hjemmearbejde — eksakt ordlyd]
[Gentag per lektie. Udelad hele "Lektier"-blokken hvis ingen.]`;

return { ...msg, text };

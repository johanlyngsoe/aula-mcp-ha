/**
 * Home Assistant function node — Mon–Thu morning Aula digest.
 */

const COPENHAGEN = 'Europe/Copenhagen';

const today = new Date();
const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
const dayAfter = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);

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
const TODAY_ISO = ymd(today);
const TOMORROW_ISO = ymd(tomorrow);
const DAY_AFTER_ISO = ymd(dayAfter);
const NOW_ISO = nowIso(today);
const ISOWEEK = isoWeek(tomorrow);

const text = `Analysér data fra Aula og giv et dagligt overblik formateret som HTML til Telegram.

KONTEKST:
- I DAG er ${TODAY} (ISO ${TODAY_ISO}).
- NU er ${NOW_ISO} dansk tid.
- I MORGEN er ${TOMORROW} (ISO ${TOMORROW_ISO}).
- I OVERMORGEN er ${DAY_AFTER_DA} (ISO ${DAY_AFTER_ISO}).
- ISO-uge for i morgen: ${ISOWEEK}.

DATA:
- Find alle børn (kald 'aula.discover' én gang — brug manifestens childIds,
  profileIds, institutionCodes og institutionProfileIds som angivet i usage).
- Beskeder: 'aula.messages.list_threads' med pageSize=20 (de seneste 20
  tråde, nyeste først). Filtrér hårdt efter handling/ændring der gælder
  i morgen (${TOMORROW_ISO}) eller senere — aflysninger, tidsændringer,
  ekstra ting at medbringe, tilladelser eller eksplicit svar nødvendigt.
  VIGTIGT: Aflysninger, vikar-beskeder og last-minute ændringer for i
  morgen står ofte KUN i en besked (ikke i kalenderen) — så hvis en
  besked eller opslag (se nedenfor) modsiger eller supplerer
  kalender-/ugeplan-data for i morgen, lad besked-/opslag-informationen
  vinde og fremhæv den i "VIGTIGT & HANDLING".
- Opslag (klassens nyhedsfeed): KALD ALTID 'aula.posts.list' (limit=20).
  Aulas "Opslag"-feed med lærer-/skole-/klasse-info — IKKE det samme som
  beskeder.

  MEDTAG KUN opslag der enten:
    • kræver handling fra forælder (tilmelding, RSVP, samtykke,
      svar nødvendigt, deadline der ikke er udløbet),
    • beskriver en ændring der påvirker kommende dage (aflysning,
      ændret tid/sted, vikar, ekstra ting at medbringe),
    • handler om et arrangement eller en begivenhed der ligger
      i morgen (${TOMORROW_ISO}) eller senere.

  UDELAD ALTID:
    • Madplaner, ugesedler, almindelige nyhedsbreve,
    • Tilbageblik, "snap fra ugen", hilsner, generelle opdateringer,
    • Opslag om arrangementer eller deadlines der allerede er
      passeret (selv hvis opslaget blev postet for nyligt),
    • Opslag uden konkret dato hvor der ikke kræves handling fra forælder,
    • Ren info uden noget for forælderen at handle på.

  CUTOFF (vigtigt): Udled den dato/det klokkeslæt opslaget refererer til,
  og konvertér til ISO (YYYY-MM-DD eller YYYY-MM-DDTHH:MM).
    • Hvis event-datoen er FØR ${TOMORROW_ISO}, udelad opslaget.
    • Hvis event-datoen er ${TODAY_ISO} med klokkeslæt FØR ${NOW_ISO},
      udelad opslaget.
    • Hvis opslaget kun nævner et tidsrum (fx "i denne uge"), og hele
      tidsrummet ligger før ${TOMORROW_ISO}, udelad det.
    • Sammenlign på ISO-form, ikke på fri tekst. "Postet for nyligt"
      tæller ikke — det er event-datoen der afgør, ikke posteringsdatoen.

  ATTRIBUER opslag til det rigtige barn: hver post har '_institutionCode'
  (skolens kode). Match den mod children[].institution.code fra discover —
  vis opslaget under det barn der hører til samme institution. Hvis et
  opslag ikke matcher nogen institution (fx kommunale opslag), vis det
  under alle børn.
- Ugeplan: 'aula.ugeplan.<provider>' for hvert barn (provider fra discover's
  capabilities.ugeplan.tools[0]). Brug isoWeek="${ISOWEEK}" og filtrér output
  til kun ${TOMORROW_ISO} (spring weekend og andre dage over).
  Dette er allerede forælder-visningen ("Ugeplan forældre") — serveren kalder
  altid med userProfile=guardian.

  HENT HELE DAGEN: behold ALLE ugeplan-items for ${TOMORROW_ISO} (events
  + notes + lektier) — frasortér IKKE noget på forhånd. Merge derefter
  med items fra lektier-/opgaver-/huskelisten-kaldene nedenfor for samme
  dato. Først DEREFTER ruter du items til output-sektioner.

  RUTING: hvert normaliseret item har et 'kind' felt — brug det som primær
  signal (Aulas app markerer lektier visuelt, men API'et gør det via 'kind',
  ikke nødvendigvis via ordet "Læselektie" i teksten):
    • kind="event" + tid → Kalender/skema-bullet.
    • kind="lektier" / "task" / "assignment" / "opgave" / "aflevering"
      / starter med "huskelisten:assignment" → Lektier-blokken.
    • kind="note" (EasyIQ-note) → tjek content: ser det ud som lektie
      (se markører nedenfor) → Lektier-blokken; ellers → Ugeplan-highlight.
    • kind="comment" / "ugebrev" / "huskelisten:team" / "huskelisten:course"
      / andet → Ugeplan-highlight (almen info).
  BACKUP-MARKØRER hvis 'kind' er uklart — kasus-uafhængig substring i
  title/content: Læselektie, Læse, Lektie, Lektier, Hjemmearbejde,
  Hjemmeopgave, Hjemmeopgaver, Skal øves, øves derhjemme, Husk at læse,
  Husk at lære, Til i morgen, Til på <ugedag>, Til næste gang,
  Forberedelse, Forbered, Træn, Øv.
  Bevar eksakt ordlyd fra Aula hvor muligt (ellers et kort referat).

- Lektier / hjemmearbejde (kald KUN dem som discover.capabilities annoncerer
  — prøv IKKE at gætte tool-navne):
    • Hvis capabilities.lektier.tools[0] findes → kald det
      (typisk 'aula.lektier.easyiq') med isoWeek="${ISOWEEK}" og filtrér
      client-side til kun ${TOMORROW_ISO}.
    • Hvis capabilities.opgaver.tools[0] findes → kald det
      (typisk 'aula.opgaver.minuddannelse') og filtrér til ${TOMORROW_ISO}.
    • Hvis capabilities.huskelisten.tools[0] findes → kald det
      (typisk 'aula.huskelisten.systematic') og filtrér til ${TOMORROW_ISO}.
- Kalender: 'aula.calendar.events' med range="tomorrow" og profileIds per barn.

REGLER:
- TIDSZONE: Serveren returnerer allerede dansk tid (Europe/Copenhagen).
  Gør INGEN konvertering — vis tider som de er.
- KUN I MORGEN gælder for kalender, ugeplan og "VIGTIGT" — spring alt over
  der hører til ${TODAY_ISO} eller tidligere. Samme CUTOFF som ovenfor
  gælder for opslag.
- LEKTIER følger samme datovindue som ugeplan og kalender — vis kun lektier
  der hører til ${TOMORROW_ISO}. Lektier uden dato vises kun hvis ugeplanen
  knytter dem til i morgen.
- FORMAT: <b>navne</b>, <code>tider</code>, <blockquote>vigtigt</blockquote>.
  Escape <, > og & i alt indhold fra Aula.

DATOFORMAT (gælder alle datoer i outputtet):
- Hvis ISO-datoen er ${TOMORROW_ISO} → skriv "i morgen".
- Hvis ISO-datoen er ${DAY_AFTER_ISO} → skriv "i overmorgen".
- Ellers den fulde danske form uden årstal, fx "torsdag den 23. maj".
- Klokkeslæt altid som HH:MM i 24-timers format.
- Eksempler: "i morgen kl. 14:30", "i overmorgen kl. 09:00",
  "torsdag den 23. maj kl. 10:00".

STRUKTUR:
<b>📅 DAGLIGT OVERBLIK — i morgen (${TOMORROW})</b>
<b>🚨 VIGTIGT & HANDLING</b>
<blockquote>[Aflysninger eller "husk-ting" til i morgen — eller "Ingenting i dag 🟢".]</blockquote>

-----------------------------------------
[GENTAG PER BARN]:
<b>👤 [BARNETS NAVN]</b>
• <code>[Tid]</code>: [Kalender-event i morgen]
• [Besked-highlight]
• [Ugeplan-highlight for i morgen]
<i>📚 Lektier til i morgen:</i>
• [Læselektie eller andet hjemmearbejde — eksakt ordlyd hvor muligt]
[Gentag per lektie-linje. Udelad hele "Lektier"-blokken hvis ingen.]
<i>📢 Opslag:</i>
• <code>[dato per DATOFORMAT]</code> <b>[titel]</b> — [1-linje sammenfatning]
[Gentag per opslag der hører til dette barn (matchet via _institutionCode).
 Nyeste først. Udelad hele "Opslag"-linjen hvis ingen.]`;

return { ...msg, text };

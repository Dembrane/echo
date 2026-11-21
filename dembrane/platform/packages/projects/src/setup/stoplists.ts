/**
 * Words that are never a key term on their own, per project language: the function words
 * and the everyday vocabulary of a session ("meeting", "residents", "gemeente"). A key term
 * steers transcription towards a spelling; a common word gains nothing from that and can
 * be inserted where nobody said it. Kept short on purpose: the rule that a lowercase single
 * word needs a capital or an acronym in the source does most of the work, this list
 * catches common words that start a sentence or a heading.
 */

const COMMON: Record<string, string> = {
  en: `the a an and or but of to in on at for with by from about into over under after before
    this that these those it its we you they he she our your their my me us them is are was were be
    been being have has had do does did will would can could should may might must not no yes
    all any some each every more most other such only own same so than too very just also then
    there here when where why how what which who whom whose
    meeting meetings session sessions workshop workshops conversation conversations discussion
    event events evening morning afternoon day week year project projects participant participants
    resident residents people group groups table tables round rounds question questions topic
    topics agenda introduction welcome break lunch coffee closing summary results plan plans
    team community city town village neighbourhood neighborhood street municipality council
    council's school schools health care hospital patient patients staff member members
    citizen citizens public online offline today tomorrow yesterday
    mayor councillor councilor chair chairman facilitator moderator director manager officer
    volunteer volunteers nurse doctor doctors`,
  nl: `de het een en of maar van te in op aan voor met door uit over onder na bij tot om als dan
    dit dat deze die er hier daar wij we jij je u zij ze hij haar zijn hun ons onze mijn is was
    waren worden wordt werd hebben heeft had doen doet kunnen kan zou zullen moet mogen niet geen
    wel ja nee alle alles elke ieder meer meest ook nog al wat wie waar wanneer waarom hoe welke
    bijeenkomst bijeenkomsten sessie sessies workshop gesprek gesprekken discussie avond ochtend
    middag dag week jaar project projecten deelnemer deelnemers bewoner bewoners inwoner inwoners
    mensen groep groepen tafel tafels ronde rondes vraag vragen onderwerp onderwerpen agenda
    welkom pauze lunch koffie afsluiting samenvatting resultaten plan plannen team buurt wijk
    wijken straat stad dorp gemeente raad school scholen zorg ziekenhuis patiënt patiënten
    medewerker medewerkers lid leden burger burgers vandaag morgen gisteren
    wethouder burgemeester raadslid voorzitter gespreksleider facilitator directeur manager
    vrijwilliger vrijwilligers huisarts verpleegkundige van stand zaken inloop borrel plenaire
    terugkoppeling aanwezig`,
  de: `der die das ein eine einen und oder aber von zu in im auf an für mit durch aus über unter
    nach bei bis um als dann dies diese dieser es wir sie er ihr ihre sein seine unser mein ist
    sind war waren werden wird haben hat hatte tun kann können soll muss nicht kein keine ja nein
    alle mehr auch noch was wer wo wann warum wie welche
    treffen sitzung workshop gespräch gespräche diskussion abend morgen nachmittag tag woche jahr
    projekt projekte teilnehmer teilnehmende bewohner menschen gruppe gruppen tisch tische runde
    frage fragen thema themen tagesordnung pause mittagessen kaffee ergebnisse plan team
    nachbarschaft viertel straße stadt dorf gemeinde rat schule pflege krankenhaus patient
    patienten mitarbeiter mitglied mitglieder bürger heute gestern
    bürgermeister vorsitzende moderator`,
  fr: `le la les un une des et ou mais de du au aux à en dans sur pour avec par sous après avant
    ce cet cette ces il elle ils elles nous vous on son sa ses leur leurs notre votre mon est sont
    était être avoir a ont fait peut doit ne pas non oui tout tous toutes plus aussi encore que
    qui où quand pourquoi comment quel quelle
    réunion séance atelier conversation conversations discussion soirée matin après-midi jour
    semaine année projet projets participant participants habitant habitants gens groupe groupes
    table tables tour question questions sujet sujets ordre pause déjeuner café résultats plan
    équipe quartier rue ville village commune conseil école santé soins hôpital patient patients
    personnel membre membres citoyen citoyens aujourd'hui demain hier`,
  es: `el la los las un una unos unas y o pero de del al a en sobre para con por sin tras ante
    este esta estos estas ese esa eso lo le les nos su sus nuestro nuestra mi es son era fue ser
    estar ha han hace puede debe no sí todo todos todas más también que quien donde cuando porque
    como cual
    reunión sesión taller conversación conversaciones debate tarde mañana día semana año proyecto
    proyectos participante participantes vecino vecinos residentes gente grupo grupos mesa mesas
    ronda pregunta preguntas tema temas orden pausa almuerzo café resultados plan equipo barrio
    calle ciudad pueblo municipio ayuntamiento consejo escuela salud hospital paciente pacientes
    personal miembro miembros ciudadano ciudadanos hoy ayer`,
  it: `il lo la i gli le un uno una e o ma di del della a al alla da in nel nella su per con tra
    fra dopo prima questo questa questi queste quello quella che chi dove quando perché come
    quale noi voi loro suo sua nostro mio è sono era essere avere ha hanno fa può deve non sì no
    tutto tutti tutte più anche ancora
    riunione sessione laboratorio conversazione conversazioni discussione sera mattina pomeriggio
    giorno settimana anno progetto progetti partecipante partecipanti abitante abitanti persone
    gruppo gruppi tavolo tavoli turno domanda domande tema temi ordine pausa pranzo caffè
    risultati piano squadra quartiere via città paese comune consiglio scuola salute ospedale
    paziente pazienti personale membro membri cittadino cittadini oggi domani ieri`,
  uk: `і й та або але з із у в на до від за для по про під над після перед це цей ця ці той
    та те ми ви вони він вона воно наш ваш їх мій є був була були бути мати має може треба не ні
    так так усі всі все більше також ще що хто де коли чому як який яка
    зустріч зустрічі сесія семінар розмова розмови обговорення вечір ранок день тиждень рік
    проєкт проєкти учасник учасники мешканці люди група групи стіл столи раунд питання тема
    теми порядок перерва обід кава результати план команда район вулиця місто село громада рада
    школа здоровʼя лікарня пацієнт пацієнти працівники член члени громадяни сьогодні завтра вчора`,
  cs: `a i nebo ale z ze do od na v ve pro s se o po před za pod nad u k ke tento tato toto tyto
    ten ta to my vy oni on ona ono náš váš jejich můj je jsou byl byla bylo být mít má může musí
    ne ano všechno všichni více také ještě co kdo kde kdy proč jak který která
    setkání schůzka sezení workshop rozhovor rozhovory diskuse večer ráno odpoledne den týden rok
    projekt projekty účastník účastníci obyvatel obyvatelé lidé skupina skupiny stůl stoly kolo
    otázka otázky téma témata program přestávka oběd káva výsledky plán tým čtvrť ulice město
    vesnice obec rada škola zdraví nemocnice pacient pacienti personál člen členové občané dnes
    zítra včera`,
};

const sets = new Map(
  Object.entries(COMMON).map(([lang, words]) => [
    lang,
    new Set(words.split(/\s+/).filter(Boolean)),
  ]),
);

/**
 * Months and weekdays (ECHO-1055): an agenda or an invitation always has a date, and a
 * capital proves nothing about them. In English, Dutch and German, the languages most
 * material comes in.
 */
const CALENDAR = `january february march april may june july august september october november
  december monday tuesday wednesday thursday friday saturday sunday
  januari februari maart mei juni juli augustus oktober maandag dinsdag woensdag donderdag
  vrijdag zaterdag zondag
  januar februar märz juni juli oktober dezember montag dienstag mittwoch donnerstag freitag
  samstag sonntag`;

/** Every list at once: a Dutch session quotes English words, and the other way round. */
const ALL = new Set([
  ...[...sets.values()].flatMap((s) => [...s]),
  ...CALENDAR.split(/\s+/).filter(Boolean),
]);

/** True for a word (lowercased) that is common in the project language or any other we know. */
export function isCommonWord(word: string, language: string): boolean {
  const w = word.toLocaleLowerCase();
  const own = sets.get(language.toLowerCase().slice(0, 2));
  return (own?.has(w) ?? false) || ALL.has(w);
}

export const STOPLIST_LANGUAGES = [...sets.keys()];

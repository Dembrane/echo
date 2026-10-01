/**
 * The words the deck's own screens say, per language, exactly as the Python service held
 * them. The data screen follows the project's settings, never the host's typing, so it
 * cannot promise more than the platform does. Native review of the drafted languages is a
 * deployment check, legal wording first.
 */

export const DATA_COPY: Record<string, DataCopy> = {
  nl: {
    title: "Dit gebeurt er stap voor stap met je gegevens",
    scan: "Je scant de QR-code. Die telefoon maakt verbinding met dembrane.",
    "talk-anon":
      "Het geluid wordt uitgeschreven. We halen namen die naar jou kunnen leiden uit het transcript, en de organisator kan de opname niet beluisteren. Geen training, geen gedoe.",
    "talk-public":
      "Het geluid wordt uitgeschreven en geanalyseerd. De organisator kan het gebruiken voor onderzoek.",
    understand:
      "Daarna analyseert dembrane alle gesprekken om te zien wat de groep echt belangrijk vindt.",
    legal: {
      consent:
        "Voor je begint, vragen we je toestemming. De privacyverklaring van de organisator is van toepassing.",
      "client-managed": "De organisator bepaalt wat er met de gesprekken gebeurt.",
      "dembrane-events":
        "dembrane organiseert deze sessie en verwerkt de gesprekken op basis van gerechtvaardigd belang.",
    },
    hood: "Onder de motorkap gebeurt de verwerking op servers van Google Vertex AI in de EU. Opgeslagen gegevens staan versleuteld op servers in Amsterdam.",
    policy: "Privacyverklaring van de organisator",
    trust: {
      url: "https://dembrane.com/nl/trust",
      label: "Meer op dembrane.com/nl/trust",
    },
  },
  en: {
    title: "Here's what happens to your data, step by step",
    scan: "You scan the QR code, and that phone connects with dembrane.",
    "talk-anon":
      "The audio is transcribed. We scrub the transcript of any names that could lead back to you, and your host cannot listen to the recording. No training, no nonsense.",
    "talk-public": "The audio is transcribed and analysed. The host may use it for research.",
    understand:
      "Then dembrane analyses all the conversations to identify what the group really cares about.",
    legal: {
      consent:
        "You are asked for your consent before you start. The organiser's privacy policy applies.",
      "client-managed": "The organiser decides what happens with the conversations.",
      "dembrane-events":
        "dembrane organises this session and processes the conversations on the basis of legitimate interest.",
    },
    hood: "Under the hood, processing happens on Google Vertex AI servers in the EU. Stored data is encrypted on servers in Amsterdam.",
    policy: "The organiser's privacy policy",
    trust: {
      url: "https://dembrane.com/trust",
      label: "Details at dembrane.com/trust",
    },
  },
  de: {
    title: "Das geschieht Schritt für Schritt mit deinen Daten",
    scan: "Du scannst den QR-Code. Dieses Telefon verbindet sich mit dembrane.",
    "talk-anon":
      "Die Aufnahme wird transkribiert. Wir entfernen Namen aus dem Transkript, die auf dich zurückführen könnten. Der Veranstalter kann die Aufnahme nicht anhören. Kein Training, kein Unsinn.",
    "talk-public":
      "Die Aufnahme wird transkribiert und analysiert. Der Veranstalter kann sie für Forschungszwecke nutzen.",
    understand:
      "Danach analysiert dembrane alle Gespräche, um herauszufinden, was der Gruppe wirklich wichtig ist.",
    legal: {
      consent:
        "Vor dem Start bitten wir dich um deine Einwilligung. Es gilt die Datenschutzerklärung des Veranstalters.",
      "client-managed": "Der Veranstalter entscheidet, was mit den Gesprächen geschieht.",
      "dembrane-events":
        "dembrane organisiert diese Veranstaltung und verarbeitet die Gespräche auf Grundlage eines berechtigten Interesses.",
    },
    hood: "Die Verarbeitung erfolgt auf Google Vertex AI-Servern in der EU. Die Daten werden verschlüsselt auf Servern in Amsterdam gespeichert.",
    policy: "Datenschutzerklärung des Veranstalters",
    trust: {
      url: "https://dembrane.com/trust",
      label: "Mehr auf dembrane.com/trust",
    },
  },
  fr: {
    title: "Voici ce qui arrive à tes données, étape par étape",
    scan: "Tu scannes le code QR. Ce téléphone se connecte à dembrane.",
    "talk-anon":
      "L’enregistrement est transcrit. Nous retirons du texte les noms qui pourraient permettre de t’identifier. L’organisateur ne peut pas écouter l’enregistrement. Pas d’entraînement, pas de complications.",
    "talk-public":
      "L’enregistrement est transcrit et analysé. L’organisateur peut l’utiliser à des fins de recherche.",
    understand:
      "Ensuite, dembrane analyse toutes les conversations pour comprendre ce qui compte vraiment pour le groupe.",
    legal: {
      consent:
        "Nous demandons ton consentement avant de commencer. La politique de confidentialité de l’organisateur s’applique.",
      "client-managed": "L’organisateur décide de l’utilisation des conversations.",
      "dembrane-events":
        "dembrane organise cette session et traite les conversations sur la base de l’intérêt légitime.",
    },
    hood: "Le traitement a lieu sur les serveurs Google Vertex AI dans l’UE. Les données sont stockées sous forme chiffrée sur des serveurs à Amsterdam.",
    policy: "Politique de confidentialité de l’organisateur",
    trust: {
      url: "https://dembrane.com/trust",
      label: "Détails sur dembrane.com/trust",
    },
  },
  es: {
    title: "Esto es lo que ocurre con tus datos, paso a paso",
    scan: "Escaneas el código QR. Ese teléfono se conecta a dembrane.",
    "talk-anon":
      "El audio se transcribe. Eliminamos del texto los nombres que podrían identificarte. El organizador no puede escuchar la grabación. Sin entrenamiento ni complicaciones.",
    "talk-public":
      "El audio se transcribe y analiza. El organizador puede usarlo para investigación.",
    understand:
      "Después, dembrane analiza todas las conversaciones para entender qué le importa realmente al grupo.",
    legal: {
      consent:
        "Te pedimos tu consentimiento antes de empezar. Se aplica la política de privacidad del organizador.",
      "client-managed": "El organizador decide qué ocurre con las conversaciones.",
      "dembrane-events":
        "dembrane organiza esta sesión y trata las conversaciones sobre la base del interés legítimo.",
    },
    hood: "El tratamiento se realiza en servidores de Google Vertex AI en la UE. Los datos se almacenan cifrados en servidores de Ámsterdam.",
    policy: "Política de privacidad del organizador",
    trust: {
      url: "https://dembrane.com/trust",
      label: "Más información en dembrane.com/trust",
    },
  },
  it: {
    title: "Ecco cosa succede ai tuoi dati, passo dopo passo",
    scan: "Scansioni il codice QR. Questo telefono si collega a dembrane.",
    "talk-anon":
      "L’audio viene trascritto. Togliamo dal testo i nomi che potrebbero identificarti. L’organizzatore non può ascoltare la registrazione. Nessun addestramento, nessuna complicazione.",
    "talk-public":
      "L’audio viene trascritto e analizzato. L’organizzatore può usarlo per la ricerca.",
    understand:
      "Poi dembrane analizza tutte le conversazioni per capire cosa conta davvero per il gruppo.",
    legal: {
      consent:
        "Prima di iniziare, ti chiediamo il consenso. Si applica l’informativa sulla privacy dell’organizzatore.",
      "client-managed": "L’organizzatore decide cosa succede alle conversazioni.",
      "dembrane-events":
        "dembrane organizza questa sessione e tratta le conversazioni sulla base del legittimo interesse.",
    },
    hood: "Il trattamento avviene sui server Google Vertex AI nell’UE. I dati sono conservati in forma cifrata su server ad Amsterdam.",
    policy: "Informativa sulla privacy dell’organizzatore",
    trust: {
      url: "https://dembrane.com/trust",
      label: "Dettagli su dembrane.com/trust",
    },
  },
  uk: {
    title: "Що відбувається з твоїми даними, крок за кроком",
    scan: "Ти скануєш QR-код. Цей телефон з’єднується з dembrane.",
    "talk-anon":
      "Аудіозапис перетворюється на текст. Ми видаляємо з тексту імена, за якими можна було б тебе впізнати. Організатор не може прослухати запис. Без навчання моделей і зайвих складнощів.",
    "talk-public":
      "Аудіозапис перетворюється на текст і аналізується. Організатор може використовувати його для дослідження.",
    understand: "Потім dembrane аналізує всі розмови, щоб зрозуміти, що справді важливо для групи.",
    legal: {
      consent: "Перед початком ми просимо твою згоду. Діє політика конфіденційності організатора.",
      "client-managed": "Організатор вирішує, що відбувається з розмовами.",
      "dembrane-events":
        "dembrane організовує цю сесію та обробляє розмови на підставі законного інтересу.",
    },
    hood: "Обробка відбувається на серверах Google Vertex AI в ЄС. Дані зберігаються в зашифрованому вигляді на серверах в Амстердамі.",
    policy: "Політика конфіденційності організатора",
    trust: {
      url: "https://dembrane.com/trust",
      label: "Докладніше на dembrane.com/trust",
    },
  },
  cs: {
    title: "Co se děje s tvými údaji, krok za krokem",
    scan: "Naskenuješ QR kód. Tento telefon se připojí k dembrane.",
    "talk-anon":
      "Zvuk se přepíše do textu. Z textu odstraníme jména, podle kterých by tě bylo možné poznat. Pořadatel si nahrávku nemůže poslechnout. Žádné trénování, žádné zbytečnosti.",
    "talk-public": "Zvuk se přepíše a analyzuje. Pořadatel ho může využít pro výzkum.",
    understand:
      "Potom dembrane analyzuje všechny rozhovory, aby zjistilo, na čem skupině opravdu záleží.",
    legal: {
      consent:
        "Před začátkem tě požádáme o souhlas. Platí zásady ochrany osobních údajů pořadatele.",
      "client-managed": "Pořadatel rozhoduje, co se s rozhovory děje.",
      "dembrane-events":
        "dembrane pořádá tuto akci a zpracovává rozhovory na základě oprávněného zájmu.",
    },
    hood: "Zpracování probíhá na serverech Google Vertex AI v EU. Údaje se ukládají šifrovaně na serverech v Amsterdamu.",
    policy: "Zásady ochrany osobních údajů pořadatele",
    trust: {
      url: "https://dembrane.com/trust",
      label: "Podrobnosti na dembrane.com/trust",
    },
  },
};

/** What a synthetic demo says where its host left the words empty. */
export const SYNTHETIC_COPY: Record<"nl" | "en", Record<string, string>> = {
  nl: {
    disclosure:
      "Alle uitspraken, spanningen en perspectieven in dit voorbeeld zijn verzonnen voor demonstratiedoeleinden. Het is geen verslag van een echte bijeenkomst en geeft niet weer wat mensen werkelijk vinden.",
    invitation_title: "Het begint met écht luisteren",
    invitation_text:
      "De echte verhalen komen van de mensen om wie het gaat.\n\nHun ervaringen, vragen en verschillen geven een bijeenkomst betekenis en vullen dit scherm met echte verhalen en perspectieven.",
    notice: "Synthetische demo · verzonnen perspectieven, geen echte gespreksuitkomsten.",
  },
  en: {
    disclosure:
      "Every contribution, tension and perspective in this example is fictional and created for demonstration. These are not real people's perspectives or findings from an event.",
    invitation_title: "It starts with listening to real people",
    invitation_text:
      "The real stories come from the people it is about.\n\nTheir experiences, questions and differences give a gathering its meaning and fill this screen with real stories and perspectives.",
    notice: "Synthetic demo · fictional perspectives, not real conversation findings.",
  },
};

export interface DataCopy {
  readonly title: string;
  readonly scan: string;
  readonly "talk-anon": string;
  readonly "talk-public": string;
  readonly understand: string;
  readonly legal: Readonly<Record<string, string>>;
  readonly hood: string;
  readonly policy: string;
  readonly trust: { readonly url: string; readonly label: string };
}

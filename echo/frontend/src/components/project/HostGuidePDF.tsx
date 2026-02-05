import {
	Document,
	Page,
	View,
	Text,
	Image,
	StyleSheet,
	Font,
} from "@react-pdf/renderer";

// Brand colors from colors.json
const colors = {
	parchment: "#f6f4f1",
	graphite: "#2d2d2c",
	royalBlue: "#4169e1",
	goldenPollen: "#ffd166",
	springGreen: "#1effa1",
};

// Hardcoded translations for 6 languages
const translations = {
	en: {
		title: "How to Record",
		step1: "Scan the QR code",
		step2_name: "Enter your name or topic",
		step2_no_name: "Tap Start",
		step3: "Start recording - make sure everyone is heard",
		step4: "Done? Press Finish Recording",
		important: "IMPORTANT",
		warning1: "Turn OFF battery saver",
		warning2: "Screen must stay ON during recording",
		warning3: "Screen black? It's not recording.",
		tip: "Need a break? Press STOP, then Resume when ready.",
	},
	nl: {
		title: "Hoe op te nemen",
		step1: "Scan de QR-code",
		step2_name: "Vul je naam of onderwerp in",
		step2_no_name: "Tik op Start",
		step3: "Start opname - zorg dat iedereen te horen is",
		step4: "Klaar? Druk op Opname Afronden",
		important: "BELANGRIJK",
		warning1: "Zet batterijbesparing UIT",
		warning2: "Scherm moet AAN blijven tijdens opname",
		warning3: "Scherm zwart? Dan neemt hij niet op.",
		tip: "Pauze nodig? Druk op STOP, dan Hervatten als je klaar bent.",
	},
	de: {
		title: "So nehmen Sie auf",
		step1: "QR-Code scannen",
		step2_name: "Namen oder Thema eingeben",
		step2_no_name: "Auf Start tippen",
		step3: "Aufnahme starten - alle sollten zu horen sein",
		step4: "Fertig? Aufnahme beenden drucken",
		important: "WICHTIG",
		warning1: "Energiesparmodus AUS",
		warning2: "Bildschirm muss AN bleiben",
		warning3: "Bildschirm schwarz? Keine Aufnahme.",
		tip: "Pause notig? STOP drucken, dann Fortsetzen.",
	},
	fr: {
		title: "Comment enregistrer",
		step1: "Scannez le QR code",
		step2_name: "Entrez votre nom ou sujet",
		step2_no_name: "Appuyez sur Demarrer",
		step3: "Demarrez - assurez-vous que tout le monde est entendu",
		step4: "Termine? Appuyez sur Terminer",
		important: "IMPORTANT",
		warning1: "Desactivez le mode economie",
		warning2: "L'ecran doit rester ALLUME",
		warning3: "Ecran noir? Pas d'enregistrement.",
		tip: "Besoin d'une pause? STOP, puis Reprendre.",
	},
	es: {
		title: "Como grabar",
		step1: "Escanea el codigo QR",
		step2_name: "Ingresa tu nombre o tema",
		step2_no_name: "Toca Iniciar",
		step3: "Inicia - asegurate de que todos sean escuchados",
		step4: "Listo? Presiona Finalizar",
		important: "IMPORTANTE",
		warning1: "Desactiva el ahorro de bateria",
		warning2: "La pantalla debe permanecer ENCENDIDA",
		warning3: "Pantalla negra? No esta grabando.",
		tip: "Necesitas un descanso? DETENER, luego Continuar.",
	},
	it: {
		title: "Come registrare",
		step1: "Scansiona il codice QR",
		step2_name: "Inserisci il tuo nome o argomento",
		step2_no_name: "Tocca Inizia",
		step3: "Inizia - assicurati che tutti siano sentiti",
		step4: "Finito? Premi Termina",
		important: "IMPORTANTE",
		warning1: "Disattiva il risparmio energetico",
		warning2: "Lo schermo deve rimanere ACCESO",
		warning3: "Schermo nero? Non sta registrando.",
		tip: "Hai bisogno di una pausa? STOP, poi Riprendi.",
	},
} as const;

type LanguageCode = keyof typeof translations;

// Styles for A4 Landscape PDF with brand colors
const styles = StyleSheet.create({
	page: {
		flexDirection: "column",
		backgroundColor: colors.parchment,
		padding: 50,
		fontFamily: "Helvetica",
	},
	header: {
		marginBottom: 30,
	},
	title: {
		fontSize: 36,
		color: colors.graphite,
		marginBottom: 8,
	},
	projectName: {
		fontSize: 14,
		color: colors.graphite,
		opacity: 0.6,
	},
	mainContent: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "flex-start",
		marginBottom: 30,
		flex: 1,
	},
	stepsContainer: {
		flex: 1,
		marginRight: 50,
	},
	stepRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		marginBottom: 20,
	},
	stepNumber: {
		fontSize: 32,
		color: colors.royalBlue,
		marginRight: 16,
		minWidth: 40,
	},
	stepText: {
		fontSize: 24,
		color: colors.graphite,
		flex: 1,
		paddingTop: 6,
	},
	qrContainer: {
		width: 200,
		height: 200,
		backgroundColor: "#FFFFFF",
		padding: 12,
		borderRadius: 8,
	},
	qrImage: {
		width: "100%",
		height: "100%",
	},
	qrPlaceholder: {
		width: "100%",
		height: "100%",
		backgroundColor: "#EEEEEE",
		justifyContent: "center",
		alignItems: "center",
	},
	qrPlaceholderText: {
		fontSize: 12,
		color: colors.graphite,
		opacity: 0.5,
	},
	bottomSection: {
		flexDirection: "row",
		gap: 20,
	},
	warningsSection: {
		flex: 1,
		backgroundColor: "#FFFFFF",
		padding: 20,
		borderRadius: 8,
	},
	warningHeader: {
		flexDirection: "row",
		alignItems: "center",
		marginBottom: 12,
	},
	warningIcon: {
		fontSize: 16,
		color: colors.goldenPollen,
		marginRight: 8,
	},
	warningTitle: {
		fontSize: 14,
		color: colors.goldenPollen,
	},
	warningList: {
		paddingLeft: 24,
	},
	warningItem: {
		fontSize: 13,
		color: colors.graphite,
		marginBottom: 6,
	},
	tipSection: {
		flex: 1,
		backgroundColor: colors.springGreen,
		padding: 20,
		borderRadius: 8,
		justifyContent: "center",
	},
	tipText: {
		fontSize: 14,
		color: colors.graphite,
	},
	footer: {
		flexDirection: "row",
		justifyContent: "flex-end",
		alignItems: "center",
		marginTop: 20,
		paddingTop: 20,
		borderTopWidth: 1,
		borderTopColor: "#E5E7EB",
	},
	brandingContainer: {
		flexDirection: "row",
		alignItems: "center",
	},
	brandingLogo: {
		width: 100,
		height: 28,
	},
});

export type HostGuidePDFProps = {
	projectName: string;
	language: string;
	askForParticipantName: boolean;
	qrCodeDataUrl: string;
	logoDataUrl?: string;
};

export const HostGuidePDF = ({
	projectName,
	language,
	askForParticipantName,
	qrCodeDataUrl,
	logoDataUrl,
}: HostGuidePDFProps) => {
	// Normalize language code to 2-letter code
	const langCode = (language?.slice(0, 2) || "en") as LanguageCode;
	const t = translations[langCode] || translations.en;

	// Build steps array based on whether we ask for participant name
	const steps = askForParticipantName
		? [t.step1, t.step2_name, t.step3, t.step4]
		: [t.step1, t.step2_no_name, t.step3, t.step4];

	return (
		<Document>
			<Page size="A4" orientation="landscape" style={styles.page}>
				{/* Header with title */}
				<View style={styles.header}>
					<Text style={styles.title}>{t.title}</Text>
					<Text style={styles.projectName}>{projectName}</Text>
				</View>

				{/* Main content: Steps + QR Code */}
				<View style={styles.mainContent}>
					<View style={styles.stepsContainer}>
						{steps.map((step, index) => (
							<View key={index} style={styles.stepRow}>
								<Text style={styles.stepNumber}>{index + 1}.</Text>
								<Text style={styles.stepText}>{step}</Text>
							</View>
						))}
					</View>

					<View style={styles.qrContainer}>
						{qrCodeDataUrl ? (
							<Image style={styles.qrImage} src={qrCodeDataUrl} />
						) : (
							<View style={styles.qrPlaceholder}>
								<Text style={styles.qrPlaceholderText}>QR Code</Text>
							</View>
						)}
					</View>
				</View>

				{/* Bottom Section: Warnings + Tip */}
				<View style={styles.bottomSection}>
					<View style={styles.warningsSection}>
						<View style={styles.warningHeader}>
							<Text style={styles.warningIcon}>!</Text>
							<Text style={styles.warningTitle}>{t.important}</Text>
						</View>
						<View style={styles.warningList}>
							<Text style={styles.warningItem}>- {t.warning1}</Text>
							<Text style={styles.warningItem}>- {t.warning2}</Text>
							<Text style={styles.warningItem}>- {t.warning3}</Text>
						</View>
					</View>

					<View style={styles.tipSection}>
						<Text style={styles.tipText}>{t.tip}</Text>
					</View>
				</View>

				{/* Footer with logo */}
				<View style={styles.footer}>
					<View style={styles.brandingContainer}>
						{logoDataUrl && (
							<Image style={styles.brandingLogo} src={logoDataUrl} />
						)}
					</View>
				</View>
			</Page>
		</Document>
	);
};

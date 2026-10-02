/** The soft colour washes behind onboarding and the pages that share its look. */
export function GradientBlurs() {
	return (
		<>
			<div
				style={{
					background:
						"radial-gradient(circle, rgba(65,105,225,0.07) 0%, transparent 70%)",
					borderRadius: "50%",
					filter: "blur(60px)",
					height: 500,
					pointerEvents: "none",
					position: "absolute",
					right: "-5%",
					top: "-10%",
					width: 500,
				}}
			/>
			<div
				style={{
					background:
						"radial-gradient(circle, rgba(30,255,161,0.05) 0%, transparent 70%)",
					borderRadius: "50%",
					bottom: "0%",
					filter: "blur(60px)",
					height: 400,
					left: "-5%",
					pointerEvents: "none",
					position: "absolute",
					width: 400,
				}}
			/>
			<div
				style={{
					background:
						"radial-gradient(circle, rgba(255,194,255,0.04) 0%, transparent 70%)",
					borderRadius: "50%",
					filter: "blur(60px)",
					height: 350,
					left: "60%",
					pointerEvents: "none",
					position: "absolute",
					top: "40%",
					width: 350,
				}}
			/>
		</>
	);
}

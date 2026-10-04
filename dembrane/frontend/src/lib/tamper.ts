// Pressing a disabled control flashes its lines red (rules.css, app-tamper).
// Browsers give a disabled control no :active state, but its pointerdown still
// arrives, so one listener for the whole app marks the control for the flash.
const CONTROL =
	".mantine-Input-wrapper, .mantine-Checkbox-root, .mantine-Radio-root, .mantine-Switch-root, .mantine-Chip-root";

document.addEventListener(
	"pointerdown",
	(event) => {
		const control = (event.target as Element | null)?.closest?.(CONTROL);
		if (!control?.querySelector(":disabled, [data-disabled]")) return;
		// Restart the flash when it is pressed again mid-flash.
		control.removeAttribute("data-tamper");
		void (control as HTMLElement).offsetWidth;
		control.setAttribute("data-tamper", "");
		control.addEventListener(
			"animationend",
			() => control.removeAttribute("data-tamper"),
			{ once: true },
		);
	},
	true,
);

// Pressing a disabled control or button flashes its lines red (rules.css, app-tamper).
// Browsers give a disabled control no :active state, but its pointerdown still
// arrives, so one listener for the whole app marks the control for the flash.
const CONTROL =
	".mantine-Button-root, .mantine-Input-wrapper, .mantine-Checkbox-root, .mantine-Radio-root, .mantine-Switch-root, .mantine-Chip-root";
const DISABLED = ":disabled, [data-disabled]";

document.addEventListener(
	"pointerdown",
	(event) => {
		const control = (event.target as Element | null)?.closest?.(CONTROL);
		if (!control?.matches(DISABLED) && !control?.querySelector(DISABLED))
			return;
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

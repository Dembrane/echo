import { useMediaQuery } from "@mantine/hooks";

export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

// True below Tailwind's md breakpoint; re-renders only on breakpoint crossings.
export function useIsMobile(): boolean {
	return (
		useMediaQuery(MOBILE_MEDIA_QUERY, false, {
			getInitialValueInEffect: false,
		}) ?? false
	);
}

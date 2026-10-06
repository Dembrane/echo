import type React from "react";
import { useComputedColorScheme } from "@mantine/core";
import { Toaster as Sonner, toast as sonnerToast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Toasts are parchment sheets between two rules with a status-coloured icon
// (styles/rules.css, .app-toast). Sonner renders them unstyled so nothing of
// its default card leaks through.
const Toaster = ({ ...props }: ToasterProps) => {
	const scheme = useComputedColorScheme("light");
	return (
		<Sonner
			theme={scheme}
			className="toaster group"
			closeButton
			position="top-center"
			toastOptions={{
				classNames: {
					error: "app-toast-error",
					info: "app-toast-info",
					success: "app-toast-success",
					toast: "app-toast",
					warning: "app-toast-warning",
				},
				unstyled: true,
			}}
			{...props}
		/>
	);
};

const toast = sonnerToast;

export { Toaster, toast };

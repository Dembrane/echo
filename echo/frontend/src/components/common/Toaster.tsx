import type React from "react";
// import { useTheme } from "next-themes";
import { Toaster as Sonner, toast as sonnerToast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
	// const { theme = "light" } = useTheme();

	return (
		<Sonner
			theme={"light" as ToasterProps["theme"]}
			className="toaster group"
			closeButton
			position="bottom-left"
			toastOptions={{
				classNames: {
					actionButton:
						"group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
					cancelButton:
						"group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
					description: "group-[.toast]:text-muted-foreground",
					toast:
						"group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
				},
			}}
			{...props}
		/>
	);
};

const toast = sonnerToast;

export { Toaster, toast };

import { BackButton } from "../primitives/BackButton";

interface StubViewProps {
	title: string;
	backTo: string | null;
	backLabel?: string;
}

export const StubView = ({ title, backTo, backLabel }: StubViewProps) => {
	return (
		<nav className="flex flex-col gap-0.5 p-1.5">
			{backTo ? <BackButton to={backTo} label={backLabel ?? "Back"} /> : null}
			<div
				className="px-2 pt-3 text-sm"
				style={{ color: "rgba(45, 45, 44, 0.6)" }}
			>
				{title}
			</div>
			<div
				className="px-2 pt-1 text-xs"
				style={{ color: "rgba(45, 45, 44, 0.4)" }}
			>
				Coming soon
			</div>
		</nav>
	);
};

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	CloseButton,
	Modal,
	Text,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { roles } from "@/colors";
import { useWorkspace } from "@/hooks/useWorkspace";
import { cn } from "@/lib/utils";
import { type SearchHit, useSearchHits } from "../hooks/useSearchHits";
import { RAIL_ITEM_CLASS, RailTip, useInRail } from "../shell/rail";
import classes from "./SearchBlock.module.css";

export const SearchBlock = () => {
	const [opened, { open, close }] = useDisclosure(false);
	const [q, setQ] = useState("");
	// Keyboard highlight: first result while searching, -1 (none) when empty.
	const [activeIndex, setActiveIndex] = useState(-1);
	const { workspaces } = useWorkspace();
	const navigate = useNavigate();
	const [shortcut, setShortcut] = useState("⌘K");
	const searchInputRef = useRef<HTMLInputElement>(null);
	const inRail = useInRail();

	useEffect(() => {
		const isMac =
			typeof window !== "undefined" &&
			/Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
		if (!isMac) {
			setShortcut("Ctrl K");
		}
	}, []);

	// Deep search only runs while the palette is open.
	const { hits, isFetching } = useSearchHits(q, workspaces, {
		enabled: opened,
	});

	// Global ⌘K / Ctrl+K — open palette anywhere.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
				e.preventDefault();
				open();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	// Clear after the exit animation, not on close, to avoid flashing the unfiltered list.
	const onClosed = () => {
		setQ("");
		setActiveIndex(-1);
	};

	const onSelect = (hit: SearchHit) => {
		close();
		navigate(hit.href);
	};

	const onClear = () => {
		setQ("");
		setActiveIndex(-1);
		searchInputRef.current?.focus();
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActiveIndex((i) => Math.min(i + 1, hits.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActiveIndex((i) => Math.max(i - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const hit = hits[activeIndex];
			if (hit) onSelect(hit);
		}
	};

	return (
		<>
			{inRail ? (
				<RailTip
					label={
						<>
							<Trans>Search</Trans>{" "}
							<span style={{ color: "var(--mantine-color-dimmed)" }}>
								{shortcut}
							</span>
						</>
					}
				>
					<UnstyledButton
						onClick={open}
						className={cn(RAIL_ITEM_CLASS, "hover:bg-[var(--app-quiet)]")}
						style={{ color: roles.text }}
						aria-label={t`Search`}
					>
						<MagnifyingGlassIcon size={20} aria-hidden="true" />
					</UnstyledButton>
				</RailTip>
			) : (
				<UnstyledButton
					onClick={open}
					className="flex h-[30px] items-center gap-2 px-2 text-sm transition-colors hover:bg-[var(--app-quiet)]"
					style={{ color: roles.text, width: "100%" }}
					aria-label={t`Search`}
				>
					<MagnifyingGlassIcon size={16} />
					<span>
						<Trans>Search</Trans>
					</span>
					<span
						className="app-muted ml-auto px-1 py-0.5 text-xs"
						style={{
							backgroundColor: roles.quiet,
							color: "var(--mantine-color-dimmed)",
						}}
					>
						{shortcut}
					</span>
				</UnstyledButton>
			)}

			<Modal
				opened={opened}
				onClose={close}
				size="lg"
				withCloseButton={false}
				padding={0}
				centered
				styles={{ body: { padding: 0 } }}
				transitionProps={{ onExited: onClosed }}
			>
				<div className="flex flex-col">
					<div
						className="border-b p-2"
						style={{ borderColor: "var(--app-rule-color)" }}
					>
						<TextInput
							ref={searchInputRef}
							autoFocus
							value={q}
							onChange={(e) => {
								const value = e.currentTarget.value;
								setQ(value);
								setActiveIndex(value ? 0 : -1);
							}}
							onKeyDown={onKeyDown}
							leftSection={<MagnifyingGlassIcon size={16} />}
							placeholder={t`Search projects, conversations, transcripts…`}
							variant="unstyled"
							size="sm"
							rightSectionPointerEvents="auto"
							rightSection={
								q ? (
									<CloseButton
										size="sm"
										aria-label={t`Clear search`}
										onClick={onClear}
									/>
								) : undefined
							}
						/>
					</div>
					<div
						className={`${classes.list} max-h-[400px] overflow-auto p-1`}
						role="listbox"
						aria-label={t`Search results`}
					>
						{hits.length === 0 ? (
							<Text size="sm" c="dimmed" className="app-muted" px="sm" py="md">
								{isFetching ? (
									<Trans>Searching…</Trans>
								) : (
									<Trans>No matches</Trans>
								)}
							</Text>
						) : (
							hits.map((hit, i) => {
								const Icon = hit.icon;
								const active = i === activeIndex;
								return (
									<button
										type="button"
										key={hit.id}
										role="option"
										aria-selected={active}
										onClick={() => onSelect(hit)}
										className={`${classes.row} ${
											active ? classes.rowActive : ""
										} flex w-full items-center gap-2 px-2 py-2 text-left text-sm`}
									>
										<Icon size={16} />
										<span className="flex-1 truncate">{hit.label}</span>
										{hit.subtitle && (
											<span className={`${classes.subtitle} truncate text-xs`}>
												{hit.subtitle}
											</span>
										)}
									</button>
								);
							})
						)}
					</div>
				</div>
			</Modal>
		</>
	);
};

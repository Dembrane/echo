import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	CopyButton,
	Divider,
	Modal,
	Stack,
	Switch,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
	ArrowSquareOutIcon,
	CheckIcon,
	CodeIcon,
	DownloadSimpleIcon,
	LinkIcon,
	PrinterIcon,
	ShareNetworkIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useRef } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { QRCode } from "@/components/common/QRCode";
import { testId } from "@/lib/testUtils";
import classes from "./Share.module.css";

/** The one Share button an outcome has; it opens the same dialog everywhere. */
export function ShareButton({ children }: { children: ReactNode }) {
	const [opened, { open, close }] = useDisclosure(false);
	const phone = useMediaQuery("(max-width: 48em)");
	return (
		<>
			<Button
				leftSection={<ShareNetworkIcon size={20} />}
				onClick={open}
				{...testId("share-button")}
			>
				<Trans>Share</Trans>
			</Button>
			<Modal
				opened={opened}
				onClose={close}
				title={t`Share`}
				size="xl"
				centered
				fullScreen={phone}
			>
				{children}
			</Modal>
		</>
	);
}

/** A way out of Share: a big, full-width button, the same shape everywhere. */
export const shareAction = {
	fullWidth: true,
	justify: "flex-start",
	size: "lg",
} as const;

export type QRLinks = {
	/** What Copy link copies; the default for the rest. */
	url: string;
	/** Encoded in the code on screen. */
	scan?: string;
	/** Where Open link goes. */
	open?: string;
	/** Encoded in the downloaded PNG. */
	download?: string;
};

/**
 * The code is the share: big enough to hold up to a camera, with every way to
 * pass it on beside it. The same four everywhere, then, under a line, what
 * this outcome adds.
 */
export function QRShare({
	links,
	embed,
	fileName,
	extras,
	onAction,
}: {
	links: QRLinks;
	/** Given, Share offers Copy embed code. */
	embed?: string;
	fileName: string;
	/** Buttons (with `shareAction`) for what this outcome adds. */
	extras?: ReactNode;
	onAction?: (action: "copy" | "open" | "download" | "embed") => void;
}) {
	const downloadRef = useRef<HTMLDivElement>(null);
	const download = () => {
		const canvas = downloadRef.current?.querySelector("canvas");
		if (!canvas) return;
		const anchor = document.createElement("a");
		anchor.download = `qr-${fileName}.png`;
		anchor.href = canvas.toDataURL("image/png");
		anchor.click();
		onAction?.("download");
	};
	return (
		<div className={classes.share} {...testId("share-qr")}>
			<div className={classes.layout}>
				<QRCode
					className={classes.code}
					value={links.scan ?? links.url}
					aria-label={t`QR code`}
				/>
				<div className={classes.links}>
					<CopyButton value={links.url} timeout={2000}>
						{({ copied, copy }) => (
							<Button
								{...shareAction}
								leftSection={
									copied ? <CheckIcon size={20} /> : <LinkIcon size={20} />
								}
								onClick={() => {
									copy();
									onAction?.("copy");
								}}
								{...testId("share-copy-link")}
							>
								{copied ? t`Copied` : t`Copy link`}
							</Button>
						)}
					</CopyButton>
					<Button
						{...shareAction}
						component="a"
						href={links.open ?? links.url}
						target="_blank"
						rel="noopener noreferrer"
						leftSection={<ArrowSquareOutIcon size={20} />}
						onClick={() => onAction?.("open")}
						{...testId("share-open-link")}
					>
						<Trans>Open link</Trans>
					</Button>
					<Button
						{...shareAction}
						leftSection={<DownloadSimpleIcon size={20} />}
						onClick={download}
						{...testId("share-download-qr")}
					>
						<Trans>Download QR code</Trans>
					</Button>
					{embed && (
						<CopyButton value={embed} timeout={2000}>
							{({ copied, copy }) => (
								<Button
									{...shareAction}
									leftSection={
										copied ? <CheckIcon size={20} /> : <CodeIcon size={20} />
									}
									onClick={() => {
										copy();
										onAction?.("embed");
									}}
									{...testId("share-copy-embed")}
								>
									{copied ? t`Copied` : t`Copy embed code`}
								</Button>
							)}
						</CopyButton>
					)}
					{extras && (
						<>
							<Divider my="xs" />
							{extras}
						</>
					)}
				</div>
			</div>
			{/* Off screen, black on white whatever the theme: the PNG people print. */}
			<div
				ref={downloadRef}
				aria-hidden
				className="pointer-events-none absolute -left-[9999px] top-0 h-64 w-64"
			>
				<QRCode
					value={links.download ?? links.scan ?? links.url}
					inverted={false}
				/>
			</div>
		</div>
	);
}

/** Share's whole content: one switch, and the code once there is a page. */
export function ShareControls({
	isPublic,
	onPublicChange,
	pending,
	description,
	settings,
	qr,
	children,
}: {
	isPublic: boolean;
	onPublicChange: (value: boolean) => void;
	pending?: boolean;
	description: string;
	/** Settings that only apply to a public page, under the switch. */
	settings?: ReactNode;
	/** The code and its menu; left out while there is no link yet. */
	qr?: ReactNode;
	/** A line the outcome needs said, under the code. */
	children?: ReactNode;
}) {
	return (
		<Stack gap="md" {...testId("share-controls")}>
			<Switch
				label={t`Public page`}
				description={description}
				checked={isPublic}
				disabled={pending}
				onChange={(event) => onPublicChange(event.currentTarget.checked)}
				{...testId("share-public-toggle")}
			/>
			{isPublic && settings}
			{isPublic && qr}
			{children}
		</Stack>
	);
}

/**
 * The sheets that go on the tables, for the portal and Present: today the host
 * guide with its code, printed or saved as PDF from its own page.
 */
// ponytail: the host guide page only; the data policy page joins it once its words leave the deck.
export function EventPrintoutsItem({
	workspaceId,
	projectId,
}: {
	workspaceId: string;
	projectId: string;
}) {
	return (
		<Button
			{...shareAction}
			component={I18nLink}
			to={`/w/${workspaceId}/projects/${projectId}/host-guide?print=1`}
			target="_blank"
			leftSection={<PrinterIcon size={20} />}
			{...testId("share-event-printouts")}
		>
			<Trans>Download event printouts</Trans>
		</Button>
	);
}

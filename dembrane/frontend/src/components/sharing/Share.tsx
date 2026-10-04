import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	CopyButton,
	Menu,
	Modal,
	Stack,
	Switch,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
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

/** The one Share button an outcome has; it opens the same dialog everywhere. */
export function ShareButton({ children }: { children: ReactNode }) {
	const [opened, { open, close }] = useDisclosure(false);
	return (
		<>
			<Button
				leftSection={<ShareNetworkIcon size={20} />}
				onClick={open}
				{...testId("share-button")}
			>
				<Trans>Share</Trans>
			</Button>
			<Modal opened={opened} onClose={close} title={t`Share`}>
				{children}
			</Modal>
		</>
	);
}

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
 * The code is the share: one object on screen, big enough to hold up to a
 * camera. Pressing it gives the same four shortcuts everywhere, then, under a
 * line, what this outcome adds.
 */
export function QRMenu({
	links,
	embed,
	fileName,
	extras,
	onAction,
	size = 200,
}: {
	links: QRLinks;
	/** Given, the menu offers Copy embed code. */
	embed?: string;
	fileName: string;
	/** Menu items for what this outcome adds. */
	extras?: ReactNode;
	onAction?: (action: "copy" | "open" | "download" | "embed") => void;
	size?: number | string;
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
		<>
			<Menu position="bottom-start">
				<Menu.Target>
					<UnstyledButton
						className="app-do"
						p="xs"
						w={size}
						maw="100%"
						aria-label={t`Share options`}
						{...testId("share-qr")}
					>
						<QRCode value={links.scan ?? links.url} />
					</UnstyledButton>
				</Menu.Target>
				<Menu.Dropdown>
					<CopyButton value={links.url} timeout={2000}>
						{({ copied, copy }) => (
							<Menu.Item
								closeMenuOnClick={false}
								leftSection={
									copied ? <CheckIcon size={16} /> : <LinkIcon size={16} />
								}
								onClick={() => {
									copy();
									onAction?.("copy");
								}}
								{...testId("share-copy-link")}
							>
								{copied ? t`Copied` : t`Copy link`}
							</Menu.Item>
						)}
					</CopyButton>
					<Menu.Item
						component="a"
						href={links.open ?? links.url}
						target="_blank"
						rel="noopener noreferrer"
						leftSection={<ArrowSquareOutIcon size={16} />}
						onClick={() => onAction?.("open")}
						{...testId("share-open-link")}
					>
						<Trans>Open link</Trans>
					</Menu.Item>
					<Menu.Item
						leftSection={<DownloadSimpleIcon size={16} />}
						onClick={download}
						{...testId("share-download-qr")}
					>
						<Trans>Download QR code</Trans>
					</Menu.Item>
					{embed && (
						<CopyButton value={embed} timeout={2000}>
							{({ copied, copy }) => (
								<Menu.Item
									closeMenuOnClick={false}
									leftSection={
										copied ? <CheckIcon size={16} /> : <CodeIcon size={16} />
									}
									onClick={() => {
										copy();
										onAction?.("embed");
									}}
									{...testId("share-copy-embed")}
								>
									{copied ? t`Copied` : t`Copy embed code`}
								</Menu.Item>
							)}
						</CopyButton>
					)}
					{extras && (
						<>
							<Menu.Divider />
							{extras}
						</>
					)}
				</Menu.Dropdown>
			</Menu>
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
		</>
	);
}

/** Share's whole content: one switch, and the code once there is a page. */
export function ShareControls({
	isPublic,
	onPublicChange,
	pending,
	description,
	qr,
	children,
}: {
	isPublic: boolean;
	onPublicChange: (value: boolean) => void;
	pending?: boolean;
	description: string;
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
		<Menu.Item
			component={I18nLink}
			to={`/w/${workspaceId}/projects/${projectId}/host-guide?print=1`}
			target="_blank"
			leftSection={<PrinterIcon size={16} />}
			{...testId("share-event-printouts")}
		>
			<Trans>Download event printouts</Trans>
		</Menu.Item>
	);
}

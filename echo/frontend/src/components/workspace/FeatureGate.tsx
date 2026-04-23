import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Modal,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { toast } from "@/components/common/Toaster";
import { TierCapacityMatrix } from "@/components/workspace/TierCapacityMatrix";
import { API_BASE_URL } from "@/config";
import { emitFrozenFeatureAttempt } from "@/lib/frozenFeatureAttempt";

/**
 * Tier-gating UI primitives for the ECHO platform.
 *
 * Locks in the designer's Ask 4 decisions (D9, D20):
 *   - Gate affordance = modal only, no hover tooltip (hover reads as
 *     marketing pressure).
 *   - Role-aware: admin/owner sees "Request upgrade" primary. Member
 *     sees no primary CTA — only dismiss ("ask a team admin" is the
 *     message, not a button).
 *   - "dembrane" lowercase, no "AI", no "successfully" per brand rules.
 *
 * Exports:
 *   - <FeatureGate /> — hatched overlay for whole feature surfaces (4B)
 *   - <UpgradeModal />  — one-feature, one-CTA modal (4C), usable standalone
 *   - requiredTierCopy  — shared "This feature requires X plan" text
 */

export type Tier =
	| "pilot"
	| "pioneer"
	| "innovator"
	| "changemaker"
	| "guardian";

const TIER_LABEL: Record<Tier, string> = {
	pilot: "pilot",
	pioneer: "pioneer",
	innovator: "innovator",
	changemaker: "changemaker",
	guardian: "guardian",
};

interface FeatureGateProps {
	/** Currently-resolved workspace tier. */
	currentTier: Tier;
	/** Minimum tier the wrapped feature requires. */
	requiredTier: Tier;
	/** "Whitelabel branding" / "Data export" / "API access" etc. */
	featureName: string;
	/** One-line benefit sentence. */
	benefit: string;
	/** `true` if the caller has admin/owner role in this workspace. */
	canRequestUpgrade: boolean;
	/** Workspace id so the modal can POST /v2/workspaces/:id/upgrade-request. */
	workspaceId: string;
	/** The gated feature's normal render — shown under the hatched overlay. */
	children: ReactNode;
}

const TIER_ORDER: Tier[] = [
	"pilot",
	"pioneer",
	"innovator",
	"changemaker",
	"guardian",
];

function meetsTier(current: Tier, required: Tier): boolean {
	return TIER_ORDER.indexOf(current) >= TIER_ORDER.indexOf(required);
}

/**
 * Wraps a feature card with a hatched overlay when the tier doesn't meet
 * the minimum. The entire card becomes a click target that opens the
 * upgrade modal. If the tier is already met, renders children as-is.
 */
export function FeatureGate({
	currentTier,
	requiredTier,
	featureName,
	benefit,
	canRequestUpgrade,
	workspaceId,
	children,
}: FeatureGateProps) {
	const [modalOpen, setModalOpen] = useState(false);

	if (meetsTier(currentTier, requiredTier)) {
		return <>{children}</>;
	}

	// Deliberately do NOT render children when gated. `pointer-events: none`
	// was a tempting dimming trick but doesn't stop keyboard-level event
	// listeners, async code paths, or focus-trap components inside the
	// gated subtree (round-2 audit, Security M1). The only safe boundary
	// is "don't mount the feature at all when the tier doesn't meet" —
	// render just the gate placeholder card.
	// Matrix §3: attempting a frozen feature re-shows the post-downgrade
	// banner if it was dismissed. We fire on every gate-open; DowngradeBanner
	// only reacts when the current workspace has an active downgrade, so this
	// is a cheap no-op on never-downgraded workspaces.
	const openModal = () => {
		emitFrozenFeatureAttempt();
		setModalOpen(true);
	};

	return (
		<>
			<Box
				pos="relative"
				onClick={openModal}
				style={{
					cursor: "pointer",
					minHeight: 160,
					borderRadius: 8,
					// Soft hatched background — subtle, not alarming.
					background:
						"repeating-linear-gradient(45deg, rgba(65,105,225,0.04) 0 8px, rgba(65,105,225,0.08) 8px 16px)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
				role="button"
				tabIndex={0}
				aria-label={`${featureName} — requires ${TIER_LABEL[requiredTier]} plan`}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						openModal();
					}
				}}
			>
				<Stack gap={6} align="center" style={{ maxWidth: 280 }} p="md">
					<Badge
						color="blue"
						variant="light"
						leftSection={<IconLock size={12} />}
					>
						{TIER_LABEL[requiredTier]}
					</Badge>
					<Text size="sm" ta="center" fw={500}>
						{featureName}
					</Text>
					<Text size="sm" ta="center" c="dimmed" fw={400}>
						{benefit}
					</Text>
				</Stack>
			</Box>
			<UpgradeModal
				opened={modalOpen}
				onClose={() => setModalOpen(false)}
				currentTier={currentTier}
				requiredTier={requiredTier}
				featureName={featureName}
				benefit={benefit}
				canRequestUpgrade={canRequestUpgrade}
				workspaceId={workspaceId}
			/>
		</>
	);
}

interface UpgradeModalProps {
	opened: boolean;
	onClose: () => void;
	currentTier: Tier;
	requiredTier: Tier;
	featureName: string;
	benefit: string;
	/** Admin/owner sees Request Upgrade. Member sees message-only per D9. */
	canRequestUpgrade: boolean;
	workspaceId: string;
}

/**
 * Ask 4C — one feature, one benefit, one tier, one CTA.
 *
 * Admin path: "Request upgrade" posts to /v2/workspaces/:id/upgrade-request.
 * Member path: informational only; the copy says "ask a team admin" but
 * there's no button — Q3 decision (D9). Keeping the message honest:
 * there's nothing we can do for them, only their admin can.
 */
export function UpgradeModal({
	opened,
	onClose,
	currentTier,
	requiredTier,
	featureName,
	benefit,
	canRequestUpgrade,
	workspaceId,
}: UpgradeModalProps) {
	const [message, setMessage] = useState("");
	const [sending, setSending] = useState(false);

	const handleRequest = async () => {
		// Guard against double-fire: Mantine's `loading` prop doesn't disable
		// the button, so a fast double-click would fire two POSTs before the
		// first setSending(true) paints (round-2 audit, Reliability H2).
		if (sending) return;
		setSending(true);
		try {
			const res = await fetch(
				`${API_BASE_URL}/v2/workspaces/${workspaceId}/upgrade-request`,
				{
					body: JSON.stringify({
						target_tier: requiredTier,
						message: message.trim() || undefined,
					}),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const detail = typeof data.detail === "string"
					? data.detail
					: t`Couldn't send the request`;
				throw new Error(detail);
			}
			toast.success(t`Request sent — we'll be in touch.`);
			onClose();
			setMessage("");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t`Couldn't send`);
		} finally {
			setSending(false);
		}
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={<Text fw={500}>{featureName}</Text>}
			centered
			size="md"
		>
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					{benefit}
				</Text>

				{/* Matrix §1 requires the full capacity matrix visible in-
				    product on the upgrade-request modal. fromTier clips the
				    table to tiers strictly above the current; highlightTier
				    calls out the minimum tier the gate needs. */}
				<TierCapacityMatrix
					fromTier={currentTier}
					highlightTier={requiredTier}
					compact
				/>

				{canRequestUpgrade ? (
					<>
						<Textarea
							label={t`Anything to add?`}
							placeholder={t`Optional — context for our team.`}
							value={message}
							onChange={(e) => setMessage(e.currentTarget.value)}
							minRows={2}
							maxRows={5}
							autosize
						/>
						<Text size="xs" c="dimmed">
							<Trans>
								Pricing is still a conversation — we'll email you to work out
								what fits.
							</Trans>
						</Text>
					</>
				) : (
					<Text size="sm" c="dimmed">
						<Trans>
							A team admin can request this upgrade. You can find your admins
							in the team members list.
						</Trans>
					</Text>
				)}

				{/* Role-aware footer: admin gets primary, member gets close-only (D9) */}
				<Box style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
					<Button variant="default" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
					{canRequestUpgrade && (
						<Button
							loading={sending}
							disabled={sending}
							onClick={handleRequest}
						>
							<Trans>Request upgrade</Trans>
						</Button>
					)}
				</Box>
			</Stack>
		</Modal>
	);
}

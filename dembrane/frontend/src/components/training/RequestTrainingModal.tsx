import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Modal,
	NumberInput,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { useMemo, useState } from "react";
import type { CatalogProduct } from "./hooks";

interface RequestTrainingModalProps {
	opened: boolean;
	product: CatalogProduct | null;
	submitting: boolean;
	onClose: () => void;
	onSubmit: (extraParticipants: number, notes: string) => void;
}

/**
 * Request flow for a training. Shows a prorated cost preview (base + extra
 * participants) before sending. No payment in v1 — staff schedule and invoice.
 */
export const RequestTrainingModal = ({
	opened,
	product,
	submitting,
	onClose,
	onSubmit,
}: RequestTrainingModalProps) => {
	const [extra, setExtra] = useState(0);
	const [notes, setNotes] = useState("");

	const estimated = useMemo(() => {
		if (!product) return 0;
		return product.price_eur + (product.extra_price_eur ?? 0) * extra;
	}, [product, extra]);

	const handleClose = () => {
		setExtra(0);
		setNotes("");
		onClose();
	};

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			title={
				product ? (
					<Text fw={500}>
						<Trans>Request {product.name} training</Trans>
					</Text>
				) : (
					""
				)
			}
			data-testid="request-training-modal"
		>
			{product && (
				<Stack gap="md">
					<Text size="sm">
						<Trans>
							Up to {product.included_participants} participants are included.
						</Trans>
					</Text>

					{product.extra_price_eur != null && (
						<NumberInput
							label={t`Extra participants`}
							description={t`€${product.extra_price_eur} each, beyond the included ${product.included_participants}`}
							min={0}
							max={500}
							value={extra}
							onChange={(v) => setExtra(typeof v === "number" ? v : 0)}
						/>
					)}

					<Textarea
						label={t`Notes for our team`}
						placeholder={t`Dates that work, context, anything else`}
						autosize
						minRows={2}
						value={notes}
						onChange={(e) => setNotes(e.currentTarget.value)}
					/>

					<Text size="sm">
						<Trans>Estimated total: €{estimated}</Trans>
					</Text>

					<Group justify="flex-end">
						<Button variant="subtle" onClick={handleClose}>
							<Trans>Cancel</Trans>
						</Button>
						<Button loading={submitting} onClick={() => onSubmit(extra, notes)}>
							<Trans>Send request</Trans>
						</Button>
					</Group>
				</Stack>
			)}
		</Modal>
	);
};

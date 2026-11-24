import { t } from "@lingui/core/macro";
import { AccountsI18n } from "../i18n";
import { AskForm } from "./Questions";

/**
 * The account's question form, opened from Organisation settings > AI models with the
 * request already written, so dembrane staff know what is asked. It lands in Talk to us.
 */
export function AskForGoogle({
	orgId,
	orgName,
	onDone,
}: {
	orgId: string;
	orgName: string;
	onDone: () => void;
}) {
	return (
		<AccountsI18n>
			<AskForm
				orgId={orgId}
				side="customer"
				onDone={onDone}
				initial={{
					body: t`Please allow Google Vertex AI in the EU, billed per use, for ${orgName}.`,
					subject: t`Google Vertex AI`,
				}}
			/>
		</AccountsI18n>
	);
}

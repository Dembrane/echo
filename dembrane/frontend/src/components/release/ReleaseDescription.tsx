import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./ReleaseVideoModal.module.css";

export const ReleaseDescription = ({
	description,
	compact = false,
}: {
	description: string;
	compact?: boolean;
}) => (
	<div className={`${styles.body} ${compact ? styles.compactBody : ""}`}>
		<ReactMarkdown
			components={{
				a: ({ children, href }) => (
					<a href={href} rel="noopener noreferrer" target="_blank">
						{children}
					</a>
				),
			}}
			remarkPlugins={[remarkGfm]}
		>
			{description}
		</ReactMarkdown>
	</div>
);

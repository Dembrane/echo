import { Breadcrumbs as MantineBreadcrumbs, Text } from "@mantine/core";
import type React from "react";
import { I18nLink } from "@/components/common/i18nLink";

interface BreadcrumbItem {
	label: React.ReactNode;
	link?: string;
}

interface BreadcrumbsProps {
	items: BreadcrumbItem[];
}

export const Breadcrumbs = ({ items }: BreadcrumbsProps) => {
	return (
		<MantineBreadcrumbs className="flex-wrap">
			{items.map((item, index) => {
				const key = item.link || `${item.label}-${index}`;

				if (item.link) {
					return (
						<I18nLink
							to={item.link}
							key={key}
							className="no-underline hover:underline"
						>
							<Text component="span" size="sm" c="dimmed" className="app-muted">
								{item.label}
							</Text>
						</I18nLink>
					);
				}

				return (
					<Text key={key} size="sm">
						{item.label}
					</Text>
				);
			})}
		</MantineBreadcrumbs>
	);
};

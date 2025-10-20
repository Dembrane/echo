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
							className="text-2xl font-semibold text-gray-500 no-underline hover:underline"
						>
							{item.label}
						</I18nLink>
					);
				}

				return (
					<Text key={key} className="text-2xl font-semibold">
						{item.label}
					</Text>
				);
			})}
		</MantineBreadcrumbs>
	);
};

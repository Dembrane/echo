// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { UserMenu } from "./UserMenu";

const blocked = vi.hoisted(() => ({ org: null as unknown }));

vi.mock("@/components/auth/hooks", () => ({
	useAuthenticated: () => ({ isAuthenticated: true }),
	useCurrentUser: () => ({
		data: { email: "jorim@example.org", first_name: "Jorim" },
	}),
	useLogoutMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/useV2Me", () => ({ useV2Me: () => ({ data: {} }) }));
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => vi.fn() }));
vi.mock("@/hooks/useManagedFreeOrg", () => ({
	useManagedFreeOrg: () => blocked.org,
}));
vi.mock("@/components/layout/TransitionCurtainProvider", () => ({
	useTransitionCurtain: () => ({ runTransition: vi.fn() }),
}));
vi.mock("@/components/common/UserAvatar", () => ({
	UserAvatar: () => <span data-testid="avatar" />,
}));
vi.mock("@/components/language/LanguagePicker", () => ({
	LanguagePicker: () => null,
}));
vi.mock("@/components/settings/ColorSchemeSettingsCard", () => ({
	ColorSchemeControl: () => null,
}));
vi.mock("@/components/organisation/CreateOrganisationModal", () => ({
	CreateOrganisationModal: ({ opened }: { opened: boolean }) =>
		opened ? <div data-testid="create-org-modal" /> : null,
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});

afterEach(() => {
	cleanup();
	blocked.org = null;
});

const renderMenu = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<MemoryRouter>
					<UserMenu />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);

const createOrgItem = () =>
	screen.getByText("Create organisation").closest("button") as HTMLElement;

it("shows Create organisation as usual when the user is not blocked", () => {
	renderMenu();
	expect(
		createOrgItem().querySelector('[data-testid="unavailable-info"]'),
	).toBeNull();
});

it("marks Create organisation unavailable for a manager of a free org and still opens it", () => {
	blocked.org = { orgId: "o1", workspaceId: "w1" };
	renderMenu();
	const item = createOrgItem();
	expect(item.querySelector('[data-testid="unavailable-info"]')).toBeTruthy();
	fireEvent.click(item);
	expect(screen.getByTestId("create-org-modal")).toBeTruthy();
});

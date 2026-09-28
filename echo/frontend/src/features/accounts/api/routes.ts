import { ROUTES } from "../contract/contract.gen";
import { PROVISIONAL_ROUTES } from "./provisional";

/** Every route the screens call: the contract's, plus the provisional ones until they land. */
export const API_ROUTES = { ...ROUTES, ...PROVISIONAL_ROUTES };
export type ApiRouteName = keyof typeof API_ROUTES;

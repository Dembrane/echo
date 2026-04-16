import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { API_BASE_URL } from "@/config";

export interface WorkspaceContextValue {
	workspaceId: string | null;
	workspaceName: string | null;
	setWorkspace: (id: string, name: string) => void;
	clearWorkspace: () => void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue>({
	workspaceId: null,
	workspaceName: null,
	setWorkspace: () => {},
	clearWorkspace: () => {},
});

export const useWorkspace = () => useContext(WorkspaceContext);

const STORAGE_KEY = "dembrane_workspace_id";
const STORAGE_NAME_KEY = "dembrane_workspace_name";

export function useWorkspaceProvider(): WorkspaceContextValue {
	const [workspaceId, setId] = useState<string | null>(
		() => localStorage.getItem(STORAGE_KEY),
	);
	const [workspaceName, setName] = useState<string | null>(
		() => localStorage.getItem(STORAGE_NAME_KEY),
	);

	const setWorkspace = useCallback((id: string, name: string) => {
		localStorage.setItem(STORAGE_KEY, id);
		localStorage.setItem(STORAGE_NAME_KEY, name);
		setId(id);
		setName(name);
	}, []);

	const clearWorkspace = useCallback(() => {
		localStorage.removeItem(STORAGE_KEY);
		localStorage.removeItem(STORAGE_NAME_KEY);
		setId(null);
		setName(null);
	}, []);

	return { workspaceId, workspaceName, setWorkspace, clearWorkspace };
}

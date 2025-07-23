import { useEffect, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { directus } from "@/lib/directus";
import { useLogoutMutation } from "@/components/auth/hooks";

export const useAuthenticated = (doRedirect = false) => {
  const logoutMutation = useLogoutMutation();
  const [loading, setLoading] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const checkAuth = async () => {
    try {
      await directus.refresh();
      setIsAuthenticated(true);
    } catch (e) {
      setIsAuthenticated(false);
      await logoutMutation.mutateAsync({
        next: location.pathname,
        reason: searchParams.get("reason") ?? "",
        doRedirect,
      });
    }
  };

  useEffect(() => {
    setLoading(true);
    checkAuth()
      .catch((_e) => {})
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return { loading, isAuthenticated };
};

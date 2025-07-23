import { toast } from "@/components/common/Toaster";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { directus } from "@/lib/directus";
import {
  passwordRequest,
  passwordReset,
  readUser,
  registerUser,
  registerUserVerify,
} from "@directus/sdk";
import { ADMIN_BASE_URL } from "@/config";
import { throwWithMessage } from "../utils/errorUtils";

export const useCurrentUser = () =>
  useQuery({
    queryKey: ["users", "me"],
    queryFn: () => {
      try {
        return directus.request(readUser("me"));
      } catch (error) {
        return null;
      }
    },
  });

export const useResetPasswordMutation = () => {
  const navigate = useI18nNavigate();
  return useMutation({
    mutationFn: async ({
      token,
      password,
    }: {
      token: string;
      password: string;
    }) => {
      try {
        const response = await directus.request(passwordReset(token, password));
        return response;
      } catch (e) {
        throwWithMessage(e);
      }
    },
    onSuccess: () => {
      toast.success(
        "Password reset successfully. Please login with new password.",
      );
      navigate("/login");
    },
    onError: (e) => {
      try {
        toast.error(e.message);
      } catch (e) {
        toast.error("Error resetting password. Please contact support.");
      }
    },
  });
};

export const useRequestPasswordResetMutation = () => {
  const navigate = useI18nNavigate();
  return useMutation({
    mutationFn: async (email: string) => {
      try {
        const response = await directus.request(
          passwordRequest(email, `${ADMIN_BASE_URL}/password-reset`),
        );
        return response;
      } catch (e) {
        throwWithMessage(e);
      }
    },
    onSuccess: () => {
      toast.success("Password reset email sent successfully");
      navigate("/check-your-email");
    },
    onError: (e) => {
      toast.error(e.message);
    },
  });
};

export const useVerifyMutation = (doRedirect: boolean = true) => {
  const navigate = useI18nNavigate();

  return useMutation({
    mutationFn: async (data: { token: string }) => {
      try {
        const response = await directus.request(registerUserVerify(data.token));
        return response;
      } catch (e) {
        throwWithMessage(e);
      }
    },
    onSuccess: () => {
      toast.success("Email verified successfully.");
      if (doRedirect) {
        setTimeout(() => {
          // window.location.href = `/login?new=true`;
          navigate(`/login?new=true`);
        }, 4500);
      }
    },
    onError: (e) => {
      toast.error(e.message);
    },
  });
};

export const useRegisterMutation = () => {
  const navigate = useI18nNavigate();
  return useMutation({
    mutationFn: async (payload: Parameters<typeof registerUser>) => {
      try {
        const response = await directus.request(registerUser(...payload));
        return response;
      } catch (e) {
        try {
          throwWithMessage(e);
        } catch (inner) {
          if (inner instanceof Error) {
            if (inner.message === "You don't have permission to access this.") {
              throw new Error(
                "Oops! It seems your email is not eligible for registration at this time. Please consider joining our waitlist for future updates!",
              );
            }
          }
        }
      }
    },
    onSuccess: () => {
      toast.success("Please check your email to verify your account.");
      navigate("/check-your-email");
    },
    onError: (e) => {
      toast.error(e.message);
    },
  });
};

// todo: add redirection logic here
export const useLoginMutation = () => {
  return useMutation({
    mutationFn: (payload: Parameters<typeof directus.login>) => {
      return directus.login(...payload);
    },
    onSuccess: () => {
      toast.success("Login successful");
    },
  });
};

export const useLogoutMutation = () => {
  const queryClient = useQueryClient();
  const navigate = useI18nNavigate();

  return useMutation({
    mutationFn: async ({
      next: _,
    }: {
      next?: string;
      reason?: string;
      doRedirect: boolean;
    }) => {
      try {
        await directus.logout();
      } catch (e) {
        throwWithMessage(e);
      }
    },
    onMutate: async ({ next, reason, doRedirect }) => {
      queryClient.resetQueries();
      if (doRedirect) {
        navigate(
          "/login" +
            (next ? `?next=${encodeURIComponent(next)}` : "") +
            (reason ? `&reason=${reason}` : ""),
        );
      }
    },
  });
};

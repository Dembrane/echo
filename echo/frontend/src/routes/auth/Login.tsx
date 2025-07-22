import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { DIRECTUS_PUBLIC_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { directus } from "@/lib/directus";
import { useCreateProjectMutation } from "@/lib/query";
import { useLoginMutation } from "@/components/auth/hooks";
import { readItems, readProviders } from "@directus/sdk";
import {
  Alert,
  Anchor,
  Box,
  Button,
  Container,
  Divider,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconBrandGoogle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import React, { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router-dom";
import { I18nLink } from "@/components/common/i18nLink";
import { useLanguage } from "@/hooks/useLanguage";
import { toast } from "@/components/common/Toaster";

const LoginWithProvider = ({
  provider,
  icon,
  label,
}: {
  provider: string;
  icon: React.ReactNode;
  label: string;
}) => {
  const { language } = useLanguage();
  return (
    <Button
      component="a"
      href={`${DIRECTUS_PUBLIC_URL}/auth/login/${provider}?redirect=${encodeURIComponent(
        window.location.origin + `/${language}/projects`,
      )}`}
      size="lg"
      c="gray"
      color="gray.6"
      variant="outline"
      rightSection={icon}
      fullWidth
    >
      {label}
    </Button>
  );
};

export const LoginRoute = () => {
  useDocumentTitle(t`Login | Dembrane`);
  const { register, handleSubmit } = useForm<{
    email: string;
    password: string;
  }>();

  const [searchParams, _setSearchParams] = useSearchParams();

  const providerQuery = useQuery({
    queryKey: ["auth-providers"],
    queryFn: () => directus.request(readProviders()),
  });

  const navigate = useI18nNavigate();
  const createProjectMutation = useCreateProjectMutation();

  const [error, setError] = useState("");
  const loginMutation = useLoginMutation();

  const onSubmit = handleSubmit(async (data) => {
    try {
      setError("");
      await loginMutation.mutateAsync([data.email, data.password]);

      const projectsCount = await directus.request<Project[]>(
        readItems("project", { limit: 1 }),
      );
      const isNewAccount =
        searchParams.get("new") === "true" && projectsCount.length === 0;

      if (isNewAccount) {
        toast(t`Setting up your first project`);
        await loginMutation.mutateAsync([data.email, data.password]);
        const project = await createProjectMutation.mutateAsync({
          name: t`New Project`,
        });
        navigate(`/projects/${project.id}/overview`);
        return;
      }

      const next = searchParams.get("next");
      if (!!next && next !== "/login") {
        // window.location.href = next;
        navigate(next);
      } else {
        // window.location.href = "/projects";
        navigate("/projects");
      }
    } catch (error) {
      try {
        if ((error as any).errors[0].message != "") {
          setError((error as any).errors[0].message);
        }
      } catch {
        setError(t`Something went wrong`);
      }
    }
  });

  useEffect(() => {
    if (searchParams.get("reason") === "INVALID_CREDENTIALS") {
      setError(t`Invalid credentials.`);
    }

    if (searchParams.get("reason") === "INVALID_PROVIDER") {
      setError(
        t`You must login with the same provider you used to sign up. If you face any issues, please contact support.`,
      );
    }
  }, [searchParams]);

  return (
    <Container size="sm" className="!h-full">
      <Stack className="h-full">
        <Stack className="flex-grow" gap="md">
          <Title order={1}>
            <Trans>Welcome!</Trans>
          </Title>

          {(searchParams.get("new") === "true" ||
            !!searchParams.get("next")) && (
            <Text>
              <Trans>Please login to continue.</Trans>
            </Text>
          )}

          <form onSubmit={onSubmit}>
            <Stack gap="sm">
              {error && <Alert color="red">{error}</Alert>}

              <TextInput
                label={<Trans>Email</Trans>}
                size="lg"
                {...register("email")}
                placeholder={t`Email`}
                required
                type="email"
              />
              <PasswordInput
                label={<Trans>Password</Trans>}
                size="lg"
                {...register("password")}
                placeholder={t`Password`}
                required
              />
              <div className="w-full text-right">
                <I18nLink to="/request-password-reset">
                  <Anchor variant="outline">
                    <Trans>Forgot your password?</Trans>
                  </Anchor>
                </I18nLink>
              </div>
              <Button size="lg" type="submit" loading={loginMutation.isPending}>
                <Trans>Login</Trans>
              </Button>
            </Stack>
          </form>

          <Divider variant="dashed" label="or" labelPosition="center" />

          <I18nLink to="/register">
            <Button size="lg" variant="outline" fullWidth>
              <Trans>Register as a new user</Trans>
            </Button>
          </I18nLink>

          <Box>
            {providerQuery.data?.find(
              (provider) => provider.name === "google",
            ) && (
              <LoginWithProvider
                provider="google"
                icon={<IconBrandGoogle />}
                label={t`Sign in with Google`}
              />
            )}
          </Box>

          {/* {providerQuery.data?.find(
            (provider) => provider.name === "outseta",
          ) && (
            <LoginWithProvider
              provider="outseta"
              icon={<IconLogin2 />}
              label="Login"
            />
          )} */}
        </Stack>
      </Stack>
    </Container>
  );
};

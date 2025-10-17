import { Box, Button, Text, Title } from "@mantine/core";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { DEBUG_MODE } from "@/config";
import { BaseLayout } from "../layout/BaseLayout";

export const ErrorPage = () => {
	const error = useRouteError();

	return (
		<BaseLayout>
			<Box className="flex h-[calc(100vh-60px)] flex-col items-center justify-center gap-4 p-4">
				<Title order={1}>
					{isRouteErrorResponse(error)
						? `${error.status} ${error.statusText}`
						: "Oops!"}
				</Title>
				<Text>
					{isRouteErrorResponse(error)
						? error.data?.message || "Page not found"
						: "Sorry, an unexpected error has occurred."}
				</Text>
				{DEBUG_MODE && (
					<div className="rounded-md border border-red-500 bg-gray-100 p-4">
						<pre>{JSON.stringify(error, null, 2)}</pre>
					</div>
				)}
				<Button
					onClick={() => {
						window.location.href = "/";
					}}
				>
					Return to Home
				</Button>
			</Box>
		</BaseLayout>
	);
};

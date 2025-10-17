import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/common/Toaster";
import {
	initiateAndUploadConversationChunk,
	uploadResourceByProjectId,
} from "@/lib/api";

export const useUploadConversation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: {
			projectId: string;
			pin: string;
			namePrefix: string;
			tagIdList: string[];
			chunks: Blob[];
			timestamps: Date[];
			email?: string;
			onProgress?: (fileName: string, progress: number) => void;
		}) => initiateAndUploadConversationChunk(payload),
		onError: (error) => {
			toast.error(
				`Upload failed: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		},
		onMutate: () => {
			// When the mutation starts, cancel any in-progress queries
			// to prevent them from overwriting our optimistic update
			queryClient.cancelQueries({ queryKey: ["conversations"] });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["conversations"],
			});
			queryClient.invalidateQueries({
				queryKey: ["projects"],
			});
			toast.success("Conversation(s) uploaded successfully");
		},
		retry: 3, // Reduced retry count to avoid too many duplicate attempts
	});
};

export const useUploadResourceByProjectIdMutation = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: uploadResourceByProjectId,
		onSuccess: (_values, variables) => {
			const projectId = variables.projectId;
			queryClient.invalidateQueries({
				queryKey: ["projects", projectId, "resources"],
			});
			toast.success("Resource uploaded successfully");
		},
		retry: 3,
	});
};

// Higher-level hook for managing conversation uploads with better state control
export const useConversationUploader = () => {
	const [isUploading, setIsUploading] = useState(false);
	const [uploadProgress, setUploadProgress] = useState<Record<string, number>>(
		{},
	);
	const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({});
	const uploadMutation = useUploadConversation();
	// Use a ref to track if we've completed the upload to avoid multiple state updates
	const hasCompletedRef = useRef(false);
	// Use refs to track previous state to avoid unnecessary updates
	const progressRef = useRef<Record<string, number>>({});
	const errorsRef = useRef<Record<string, string>>({});

	// Clean up function to reset states
	const resetUpload = useCallback(() => {
		hasCompletedRef.current = false;
		progressRef.current = {};
		errorsRef.current = {};
		setIsUploading(false);
		setUploadProgress({});
		setUploadErrors({});
		uploadMutation.reset();
	}, [uploadMutation]);

	// Handle real progress updates with debouncing
	const handleProgress = useCallback((fileName: string, progress: number) => {
		// Only update if progress actually changed by at least 1%
		if (Math.abs((progressRef.current[fileName] || 0) - progress) < 1) {
			return; // Skip tiny updates that don't matter visually
		}

		// Update the ref and then the state
		progressRef.current = {
			...progressRef.current,
			[fileName]: progress,
		};

		setUploadProgress((prev) => ({
			...prev,
			[fileName]: progress,
		}));
	}, []);

	// Upload files with real progress tracking
	const uploadFiles = useCallback(
		(payload: {
			projectId: string;
			pin: string;
			namePrefix: string;
			tagIdList: string[];
			chunks: Blob[];
			timestamps: Date[];
			email?: string;
		}) => {
			// Don't start if already uploading
			if (isUploading || uploadMutation.isPending) {
				return;
			}

			hasCompletedRef.current = false;

			// Initialize progress tracking for all files
			const initialProgress: Record<string, number> = {};
			payload.chunks.forEach((chunk) => {
				const name =
					chunk instanceof File
						? chunk.name
						: `chunk-${payload.chunks.indexOf(chunk)}`;
				initialProgress[name] = 0;
			});

			// Update refs first
			progressRef.current = initialProgress;
			errorsRef.current = {};

			// Then update state
			setUploadProgress(initialProgress);
			setUploadErrors({});
			setIsUploading(true);

			// Start the upload with progress tracking
			uploadMutation.mutate({
				...payload,
				onProgress: handleProgress,
			});
		},
		[isUploading, uploadMutation, handleProgress],
	);

	// Handle success state - separate from error handling to prevent cycles
	useEffect(() => {
		// Skip if conditions aren't right
		if (!isUploading || !uploadMutation.isSuccess || hasCompletedRef.current) {
			return;
		}

		// Set flag to prevent repeated updates
		hasCompletedRef.current = true;

		// Mark all files as complete when successful
		const fileNames = Object.keys(progressRef.current);
		if (fileNames.length > 0) {
			// Update refs first
			const completed = { ...progressRef.current };
			fileNames.forEach((key) => {
				completed[key] = 100;
			});
			progressRef.current = completed;

			// Then update state - do this once rather than per file
			setUploadProgress(completed);
		}
	}, [uploadMutation.isSuccess, isUploading]);

	// Handle error state separately
	useEffect(() => {
		// Skip if conditions aren't right
		if (!isUploading || !uploadMutation.isError) {
			return;
		}

		// Only do this once
		if (Object.keys(errorsRef.current).length > 0) {
			return;
		}

		// Set errors on failure
		const fileNames = Object.keys(progressRef.current);
		if (fileNames.length > 0) {
			// Update refs first
			const newErrors = { ...errorsRef.current };
			const errorMessage = uploadMutation.error?.message || "Upload failed";

			fileNames.forEach((key) => {
				newErrors[key] = errorMessage;
			});
			errorsRef.current = newErrors;

			// Then update state - do this once rather than per file
			setUploadErrors(newErrors);
		}
	}, [uploadMutation.isError, isUploading, uploadMutation.error]);

	return {
		error: uploadMutation.error,
		isError: uploadMutation.isError,
		isPending: uploadMutation.isPending,
		isSuccess: uploadMutation.isSuccess,
		isUploading,
		resetUpload,
		uploadErrors,
		uploadFiles,
		uploadProgress,
	};
};

import { t } from "@lingui/core/macro";
import {
	ActionIcon,
	Alert,
	Box,
	Button,
	Group,
	LoadingOverlay,
	Modal,
	Paper,
	Progress,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconAlertCircle,
	IconArrowRight,
	IconCheck,
	IconCircleCheck,
	IconEdit,
	IconFileUpload,
	IconPlus,
	IconTrash,
	IconUpload,
	IconX,
} from "@tabler/icons-react";
import {
	type PropsWithChildren,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useProjectById } from "@/components/project/hooks";
import { testId } from "@/lib/testUtils";
import { toast } from "../common/Toaster";
import { CommonDropzone } from "./Dropzone";
import { useConversationUploader } from "./hooks";

// Define file upload status type
type FileUploadStatus = {
	file: File;
	progress: number;
	status: "pending" | "uploading" | "complete" | "error";
	error?: string;
};

// Format file size to appropriate units (KB, MB)
const formatFileSize = (bytes: number): string => {
	if (bytes === 0) return "0 Bytes";

	const k = 1024;
	const sizes = ["Bytes", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
};

// Truncate file name for display
const truncateFileName = (name: string, maxLength = 25): string => {
	if (name.length <= maxLength) return name;

	const extension = name.split(".").pop() || "";
	const nameWithoutExt = name.substring(0, name.length - extension.length - 1);

	if (nameWithoutExt.length <= maxLength - 5) return name;

	const truncatedName =
		nameWithoutExt.substring(0, maxLength - 5) +
		"..." +
		(extension ? `.${extension}` : "");
	return truncatedName;
};

// Get file extension
const getFileExtension = (fileName: string): string => {
	return fileName.split(".").pop()?.toLowerCase() || "";
};

// Check if file is a valid audio file based on its content type or extension
const isAudioFile = (file: File): boolean => {
	const validAudioTypes = [
		"audio/mp3",
		"audio/wav",
		"audio/mpeg",
		"audio/ogg",
		"audio/webm",
		"audio/m4a",
		"audio/aac",
		"audio/flac",
		"audio/opus",
		"video/mp4", // MP4 can contain audio
	];

	const validExtensions = [
		"mp3",
		"wav",
		"mpeg",
		"ogg",
		"webm",
		"m4a",
		"mp4",
		"aac",
		"flac",
		"opus",
	];

	// Check MIME type first
	if (validAudioTypes.includes(file.type)) {
		return true;
	}

	// Fallback to extension check
	const extension = getFileExtension(file.name);
	return validExtensions.includes(extension);
};

// Create a new file with updated name but same content
const renameFile = (file: File, newName: string): File => {
	const extension = getFileExtension(file.name);
	const finalName = newName.endsWith(`.${extension}`)
		? newName
		: `${newName}.${extension}`;

	return new File([file], finalName, { type: file.type });
};

// Custom hook for file name editing
const useFileNameEditor = (
	files: File[],
	onFileRename: (oldFile: File, newFile: File, index: number) => void,
) => {
	const [editingIndex, setEditingIndex] = useState<number | null>(null);
	const [editValue, setEditValue] = useState<string>("");
	const inputRef = useRef<HTMLInputElement>(null);

	const startEditing = useCallback(
		(index: number) => {
			const file = files[index];
			if (!file) return;

			setEditingIndex(index);

			// Set initial value to just the filename without extension
			const extension = getFileExtension(file.name);
			const nameWithoutExt = file.name.substring(
				0,
				file.name.length - extension.length - 1,
			);
			setEditValue(nameWithoutExt);
		},
		[files],
	);

	const cancelEditing = useCallback(() => {
		setEditingIndex(null);
		setEditValue("");
	}, []);

	const saveEdit = useCallback(() => {
		if (editingIndex === null || !files[editingIndex]) return;

		const currentFile = files[editingIndex];
		const extension = getFileExtension(currentFile.name);

		// Validate file name
		if (!editValue.trim()) {
			return false; // Invalid name
		}

		// Create the new filename with extension
		const newFileName = `${editValue.trim()}.${extension}`;

		// Check for duplicates
		const isDuplicate = files.some(
			(file, idx) =>
				idx !== editingIndex &&
				file.name.toLowerCase() === newFileName.toLowerCase(),
		);

		if (isDuplicate) {
			return false; // Duplicate name
		}

		// Create the new file
		const newFile = renameFile(currentFile, editValue.trim());

		// Call the rename callback
		onFileRename(currentFile, newFile, editingIndex);

		// Reset state
		cancelEditing();
		return true;
	}, [editingIndex, editValue, files, onFileRename, cancelEditing]);

	// Focus the input when editing starts
	useEffect(() => {
		if (editingIndex !== null && inputRef.current) {
			inputRef.current.focus();
		}
	}, [editingIndex]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === "Enter") {
				e.preventDefault();
				saveEdit();
			} else if (e.key === "Escape") {
				cancelEditing();
			}
		},
		[saveEdit, cancelEditing],
	);

	return {
		cancelEditing,
		editingIndex,
		editValue,
		handleKeyDown,
		inputRef,
		saveEdit,
		setEditValue,
		startEditing,
	};
};

// Config
const MAX_FILES = 10;
const MIN_FILE_SIZE = 5 * 1024; // 5KB in bytes
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB in bytes

// Valid audio MIME types
const VALID_AUDIO_TYPES = [
	"audio/mp3",
	"audio/wav",
	"audio/mpeg",
	"audio/ogg",
	"audio/webm",
	"audio/m4a",
	"video/mp4", // MP4 can contain audio
	"audio/aac",
	"audio/flac",
	"audio/opus",
];

export const UploadConversationDropzone = (
	props: PropsWithChildren<{
		projectId: string;
	}>,
) => {
	// Modal state
	const [opened, { open, close }] = useDisclosure(false);

	// File selection and upload tracking state
	const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
	const [uploadStatus, setUploadStatus] = useState<FileUploadStatus[]>([]);
	const [globalError, setGlobalError] = useState<string | null>(null);
	const [uploadStarted, setUploadStarted] = useState(false);

	// Use our custom uploader hook
	const uploader = useConversationUploader();
	const projectQuery = useProjectById({
		projectId: props.projectId,
		query: {
			fields: ["id"],
		},
	});

	// Handle file rename with the custom hook
	const handleFileRename = (_oldFile: File, newFile: File, index: number) => {
		// Update selected files
		setSelectedFiles((prev) =>
			prev.map((file, idx) => (idx === index ? newFile : file)),
		);

		// Update upload status
		setUploadStatus((prev) =>
			prev.map((status, idx) =>
				idx === index ? { ...status, file: newFile } : status,
			),
		);
	};

	// Use the custom file name editor hook
	const fileEditor = useFileNameEditor(selectedFiles, handleFileRename);

	// Update our upload status from the uploader hook - using stable references to prevent loops
	useEffect(() => {
		// Only update if we're actually uploading and have files
		if (!uploader.isUploading || selectedFiles.length === 0) return;

		const newUploadStatus = selectedFiles.map((file) => {
			const fileName = file.name;
			const progress = uploader.uploadProgress[fileName] || 0;
			const error = uploader.uploadErrors[fileName];

			let status: "pending" | "uploading" | "complete" | "error" = "pending";
			if (error) {
				status = "error";
			} else if (progress === 100) {
				status = "complete";
			} else if (progress > 0) {
				status = "uploading";
			}

			return {
				error,
				file,
				progress,
				status,
			};
		});

		// Compare deeply before updating to prevent unnecessary renders
		const hasChanged =
			JSON.stringify(newUploadStatus) !== JSON.stringify(uploadStatus);
		if (hasChanged) {
			setUploadStatus(newUploadStatus);
		}
	}, [
		uploader.isUploading,
		uploader.uploadProgress,
		uploader.uploadErrors,
		selectedFiles,
		uploadStatus,
	]);

	// Reflect uploader error in a single place
	useEffect(() => {
		setGlobalError(
			uploader.isError
				? uploader.error?.message || t`Upload failed. Please try again.`
				: null,
		);
	}, [uploader.isError, uploader.error]);

	// Set upload started state based on uploader state
	useEffect(() => {
		setUploadStarted(uploader.isUploading);
	}, [uploader.isUploading]);

	// Track previous modal state so we only run cleanup when it transitions from open ➜ closed
	const prevOpenedRef = useRef(opened);

	// Reset states when modal **closes** (run only on the transition, not on every render)
	useEffect(() => {
		// Run cleanup only if the modal was previously open and is now closed
		if (prevOpenedRef.current && !opened) {
			// Reset in a specific order to prevent circular dependencies
			const cleanup = () => {
				fileEditor.cancelEditing();
				setGlobalError(null);
				setUploadStatus([]);
				setSelectedFiles([]);
				setUploadStarted(false);

				// This should come last as it might trigger other state changes
				uploader.resetUpload();
			};

			cleanup();
		}

		// Update the ref for the next render cycle
		prevOpenedRef.current = opened;
	}, [
		opened,
		fileEditor.cancelEditing, // This should come last as it might trigger other state changes
		uploader.resetUpload,
	]);

	// Handle file selection - make this a useCallback to ensure stability
	const handleFileSelection = useCallback(
		(files: File[]) => {
			// First filter only audio files
			const audioFiles = Array.from(files).filter((file) => {
				if (!isAudioFile(file)) {
					toast.error(
						t`File "${file.name}" is not a supported audio format. Only audio files are allowed.`,
					);
					return false;
				}
				return true;
			});

			if (audioFiles.length === 0) {
				toast.error(
					t`No valid audio files were selected. Please select audio files only (MP3, WAV, OGG, etc).`,
				);
				return;
			}

			// Check for max files limit
			let filesToProcess: File[];
			if (selectedFiles.length + audioFiles.length > MAX_FILES) {
				toast.warning(
					t`You can only upload up to ${MAX_FILES} files at a time. Only the first ${MAX_FILES - selectedFiles.length} files will be added.`,
				);

				// Only take the number of files we can still add
				filesToProcess = audioFiles.slice(0, MAX_FILES - selectedFiles.length);
			} else {
				filesToProcess = audioFiles;
			}

			// Filter out files that are too small
			const validFiles = filesToProcess.filter((file) => {
				if (file.size < MIN_FILE_SIZE) {
					toast.error(
						t`File "${file.name}" is too small (${formatFileSize(file.size)}). Minimum size is ${formatFileSize(MIN_FILE_SIZE)}.`,
					);
					return false;
				}
				return true;
			});

			if (validFiles.length === 0) return;

			// Combine existing files with new files, avoiding duplicates
			const existingFileNames = selectedFiles.map((file) => file.name);
			const newFiles = validFiles.filter(
				(file) => !existingFileNames.includes(file.name),
			);

			// Check for duplicate files
			if (newFiles.length < validFiles.length) {
				toast.info(
					t`Some files were already selected and won't be added twice.`,
				);
			}

			const updatedFiles = [...selectedFiles, ...newFiles];
			setSelectedFiles(updatedFiles);

			// Create status entries for the new files
			setUploadStatus((prevStatus) => {
				// Keep existing statuses
				const existingStatuses = prevStatus.filter((status) =>
					selectedFiles.some((file) => file.name === status.file.name),
				);

				// Create statuses for new files
				const newStatuses = newFiles.map((file) => ({
					file,
					progress: 0,
					status: "pending" as const,
				}));

				return [...existingStatuses, ...newStatuses];
			});
		},
		[selectedFiles],
	);

	// Handle file drop in dropzone
	const handleDrop = useCallback(
		(files: File[]) => {
			handleFileSelection(files);
		},
		[handleFileSelection],
	);

	// Remove file from selection
	const handleRemoveFile = useCallback((indexToRemove: number) => {
		setSelectedFiles((prev) =>
			prev.filter((_, index) => index !== indexToRemove),
		);
		setUploadStatus((prev) =>
			prev.filter((_, index) => index !== indexToRemove),
		);
	}, []);

	// Start the upload process
	const handleUpload = useCallback(() => {
		if (selectedFiles.length === 0) return;

		// Start the upload process using our uploader hook
		uploader.uploadFiles({
			chunks: selectedFiles,
			namePrefix: "",
			pin: "",
			projectId: props.projectId,
			source: "DASHBOARD_UPLOAD",
			tagIdList: [],
			timestamps: selectedFiles.map(() => new Date()),
		});
	}, [selectedFiles, props.projectId, uploader]);

	if (projectQuery.isLoading) {
		return <LoadingOverlay visible />;
	}

	return (
		<>
			{/* Upload button */}
			<Tooltip label={t`Upload conversations`}>
				<Button
					leftSection={<IconPlus size={16} />}
					onClick={open}
					variant="outline"
					{...testId("conversation-upload-button")}
				>
					{t`Upload`}
				</Button>
			</Tooltip>

			{/* Upload modal */}
			<Modal
				withinPortal
				opened={opened}
				onClose={close}
				title={
					<Text fw={600} size="lg">
						{uploadStarted
							? uploader.isSuccess
								? t`Upload Complete`
								: t`Uploading Audio Files...`
							: t`Select Audio Files to Upload`}
					</Text>
				}
				size="lg"
				centered
				{...testId("conversation-upload-modal")}
			>
				<Stack>
					{/* Notifications */}
					{/* File selection area - always available if no upload is in progress */}
					{!uploadStarted && (
						<>
							<CommonDropzone
								onDrop={handleDrop}
								maxFiles={MAX_FILES}
								maxSize={MAX_FILE_SIZE}
								onReject={(files) => {
									const errorFile = files[0];
									const error = errorFile.errors[0];

									if (error.code === "file-too-large") {
										toast.error(
											t`File "${errorFile.file.name}" exceeds the maximum size of ${formatFileSize(MAX_FILE_SIZE)}.`,
										);
									} else if (error.code === "file-invalid-type") {
										toast.error(
											t`File "${errorFile.file.name}" has an unsupported format. Only audio files are allowed.`,
										);
									} else {
										toast.error(
											t`Error uploading "${errorFile.file.name}": ${error.message}`,
										);
									}
								}}
								loading={uploader.isPending}
								accept={VALID_AUDIO_TYPES}
								{...testId("conversation-upload-dropzone")}
							>
								<Stack align="center" gap="sm">
									<IconUpload size={32} stroke={1.5} />
									<Text
										size="sm"
										fw={500}
									>{t`Drag audio files here or click to select files`}</Text>
									<Text size="xs" c="dimmed">
										{t`Supported formats: MP3, WAV, OGG, WEBM, M4A, MP4, AAC, FLAC, OPUS`}
									</Text>
									<Text size="xs" c="dimmed">
										{t`File size: Min ${formatFileSize(MIN_FILE_SIZE)}, Max ${formatFileSize(MAX_FILE_SIZE)}, up to ${MAX_FILES} files`}
									</Text>
								</Stack>
							</CommonDropzone>

							{selectedFiles.length > 0 && (
								<>
									<Box mt="md">
										<Group justify="space-between" mb="xs">
											<Text
												fw={500}
											>{t`Selected Files (${selectedFiles.length}/${MAX_FILES})`}</Text>
											{selectedFiles.length > 0 && (
												<Text
													size="sm"
													c="dimmed"
												>{t`Review files before uploading`}</Text>
											)}
										</Group>
										<Paper withBorder p="md">
											<Stack gap="xs">
												{selectedFiles.map((file, index) => (
													<Group
														key={file.name}
														justify="space-between"
														{...testId(`conversation-upload-file-${index}`)}
													>
														<Group style={{ flex: 1 }}>
															<IconFileUpload size={18} />
															{fileEditor.editingIndex === index ? (
																<TextInput
																	ref={fileEditor.inputRef}
																	value={fileEditor.editValue}
																	onChange={(e) =>
																		fileEditor.setEditValue(e.target.value)
																	}
																	onKeyDown={fileEditor.handleKeyDown}
																	style={{ flex: 1 }}
																	placeholder={t`Enter filename (without extension)`}
																	rightSection={
																		<ActionIcon
																			onClick={fileEditor.saveEdit}
																			color="green"
																			variant="subtle"
																			{...testId(
																				`conversation-upload-file-save-${index}`,
																			)}
																		>
																			<IconCheck size={16} />
																		</ActionIcon>
																	}
																	{...testId(
																		`conversation-upload-file-input-${index}`,
																	)}
																/>
															) : (
																<>
																	<Tooltip
																		label={file.name}
																		position="bottom"
																		multiline
																		maw={300}
																	>
																		<Text
																			size="sm"
																			lineClamp={1}
																			{...testId(
																				`conversation-upload-file-name-${index}`,
																			)}
																		>
																			{truncateFileName(file.name)}
																		</Text>
																	</Tooltip>
																	<Text size="xs" c="dimmed">
																		({formatFileSize(file.size)})
																	</Text>
																</>
															)}
														</Group>
														<Group gap="xs">
															{fileEditor.editingIndex !== index && (
																<Tooltip label={t`Edit file name`}>
																	<ActionIcon
																		color="primary"
																		variant="subtle"
																		onClick={() =>
																			fileEditor.startEditing(index)
																		}
																		disabled={fileEditor.editingIndex !== null}
																		{...testId(
																			`conversation-upload-file-edit-${index}`,
																		)}
																	>
																		<IconEdit size={16} />
																	</ActionIcon>
																</Tooltip>
															)}
															<Tooltip label={t`Remove file`}>
																<ActionIcon
																	color="red"
																	variant="subtle"
																	onClick={() => handleRemoveFile(index)}
																	disabled={fileEditor.editingIndex === index}
																	{...testId(
																		`conversation-upload-file-remove-${index}`,
																	)}
																>
																	<IconTrash size={16} />
																</ActionIcon>
															</Tooltip>
														</Group>
													</Group>
												))}
											</Stack>
										</Paper>
									</Box>
									<Box mt="xs">
										<Alert
											icon={<IconAlertCircle size={16} />}
											color="blue.1"
											variant="light"
										>
											{t`Click "Upload Files" when you're ready to start the upload process.`}
										</Alert>
									</Box>
								</>
							)}

							{globalError && (
								<Alert
									icon={<IconAlertCircle size={16} />}
									title={t`Error`}
									color="red.2"
									variant="light"
									withCloseButton
									onClose={() => setGlobalError(null)}
								>
									{globalError}
								</Alert>
							)}

							<Group justify="flex-end" mt="md">
								<Button
									variant="outline"
									onClick={close}
									{...testId("conversation-upload-cancel-button")}
								>
									{t`Cancel`}
								</Button>
								{selectedFiles.length > 0 && (
									<Button
										onClick={handleUpload}
										rightSection={<IconArrowRight size={16} />}
										disabled={fileEditor.editingIndex !== null}
										{...testId("conversation-upload-files-button")}
									>
										{t`Upload Files`}
									</Button>
								)}
							</Group>
						</>
					)}
					{/* Upload progress area - shown after upload has started */}
					{uploadStarted && (
						<>
							<Stack gap="md">
								{uploadStatus.map((fileStatus) => (
									<Paper
										key={fileStatus.file.name}
										withBorder
										p="md"
										pos="relative"
									>
										<Stack gap="xs">
											<Group justify="space-between">
												<Group>
													{fileStatus.status === "complete" ? (
														<IconCircleCheck size={20} color="green" />
													) : fileStatus.status === "error" ? (
														<IconX size={20} color="red" />
													) : (
														<IconUpload size={20} />
													)}
													<div>
														<Tooltip
															label={fileStatus.file.name}
															position="bottom"
															multiline
															maw={300}
														>
															<Text size="sm" fw={500} lineClamp={1}>
																{truncateFileName(fileStatus.file.name)}
															</Text>
														</Tooltip>
														<Text size="xs" c="dimmed">
															({formatFileSize(fileStatus.file.size)})
														</Text>
													</div>
												</Group>
												<Text
													size="sm"
													fw={500}
													c={
														fileStatus.status === "complete"
															? "green"
															: fileStatus.status === "error"
																? "red"
																: "blue"
													}
												>
													{fileStatus.status === "complete"
														? t`Complete`
														: fileStatus.status === "error"
															? t`Failed`
															: `${Math.round(fileStatus.progress)}%`}
												</Text>
											</Group>
											<Progress
												value={fileStatus.progress}
												color={
													fileStatus.status === "complete"
														? "green"
														: fileStatus.status === "error"
															? "red"
															: "blue"
												}
												size="md"
												radius="xl"
												animated={fileStatus.status === "uploading"}
											/>
										</Stack>
									</Paper>
								))}
							</Stack>

							{/* Error message */}
							{globalError && (
								<Alert
									icon={<IconAlertCircle size={16} />}
									title={t`Error`}
									color="red.2"
									variant="light"
									withCloseButton
									onClose={() => setGlobalError(null)}
								>
									{globalError}
								</Alert>
							)}

							{/* Success message */}
							{uploader.isSuccess && (
								<Alert
									icon={<IconCircleCheck size={16} />}
									title={t`Success`}
									color="green"
									variant="light"
								>
									{t`All files were uploaded successfully.`}
								</Alert>
							)}

							{/* Action buttons */}
							<Group justify="flex-end" mt="md">
								<Button
									variant="outline"
									onClick={close}
									disabled={uploader.isPending}
									{...testId("conversation-upload-close-button")}
								>
									{uploader.isSuccess ? t`Close` : t`Cancel`}
								</Button>
								{!uploader.isSuccess && !uploader.isPending && (
									<Button
										variant="light"
										onClick={() => {
											setUploadStarted(false);
										}}
										{...testId("conversation-upload-back-button")}
									>
										{t`Back to Selection`}
									</Button>
								)}
								{!uploader.isSuccess && uploader.isError && (
									<Button
										onClick={handleUpload}
										loading={uploader.isPending}
										{...testId("conversation-upload-retry-button")}
									>
										{t`Retry Upload`}
									</Button>
								)}
							</Group>
						</>
					)}
				</Stack>
			</Modal>
		</>
	);
};

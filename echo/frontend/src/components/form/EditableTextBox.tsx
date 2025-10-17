import {
	ActionIcon,
	InputBase,
	type InputBaseProps,
	Tooltip,
} from "@mantine/core";
import { IconDeviceFloppy, IconPencil } from "@tabler/icons-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface EditableTextBoxProps {
	value: string;
	onChange: (value: string) => Promise<void>;
	disabled?: boolean;
	placeholder?: string;
	inputProps?: InputBaseProps;
}

const EditableTextBox = ({
	value = "",
	onChange,
	disabled = false,
	placeholder = "Enter text",
	inputProps,
}: EditableTextBoxProps) => {
	const [isEditing, setIsEditing] = useState(false);
	const [localValue, setLocalValue] = useState(value ?? "");
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setLocalValue(value);
	}, [value]);

	const saveChanges = async (newValue: string) => {
		try {
			await onChange(newValue.trim());
			setError(null);
		} catch (_err) {
			setError("Failed to save changes. Please try again.");
		}
	};

	const handleChange = (e: React.ChangeEvent) => {
		// @ts-expect-error e.target.value is not typed
		const newValue = e.target.value;
		setLocalValue(newValue);
	};

	const handleBlur = () => {
		setIsEditing(false);
		saveChanges(localValue);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			handleBlur();
		}
	};

	useEffect(() => {
		if (isEditing && inputRef.current) {
			inputRef.current.focus();
		}
	}, [isEditing]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: role group here is not an ARIA attribute
		<div
			className="flex items-center justify-start"
			role="group"
			aria-label="Editable text"
		>
			<InputBase
				ref={inputRef}
				value={localValue}
				onChange={handleChange}
				onBlur={handleBlur}
				onKeyDown={handleKeyDown}
				disabled={disabled}
				placeholder={placeholder}
				aria-label="Editable text input"
				{...inputProps}
				className={cn("mr-2 min-w-[100px] py-1", inputProps?.className)}
			/>
			<Tooltip label={isEditing ? "Save changes" : "Edit text"}>
				<ActionIcon
					onClick={() => setIsEditing(!isEditing)}
					aria-label={isEditing ? "Save changes" : "Edit text"}
					variant="transparent"
				>
					{isEditing ? (
						<IconDeviceFloppy aria-hidden="true" color="gray" />
					) : (
						<IconPencil aria-hidden="true" color="gray" />
					)}
				</ActionIcon>
			</Tooltip>
			{error && (
				<p className="mt-1 text-sm text-red-500" role="alert">
					{error}
				</p>
			)}
		</div>
	);
};

export default EditableTextBox;

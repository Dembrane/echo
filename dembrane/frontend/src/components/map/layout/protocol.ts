/**
 * Messages between the layout client (main thread) and the layout worker.
 * Every compute carries a request id; a newer id supersedes every older one.
 */
import type { LayoutOutput, PackedVectors } from "./compute";

export type LayoutComputeMessage = PackedVectors & {
	type: "compute";
	requestId: number;
	nodeLimit: number;
	seed?: number;
};

export type LayoutCancelMessage = { type: "cancel"; requestId: number };

export type LayoutWorkerRequest = LayoutComputeMessage | LayoutCancelMessage;

export type LayoutErrorCode = "over-budget" | "failed";

export type LayoutWorkerResponse =
	| { type: "result"; requestId: number; result: LayoutOutput }
	| {
			type: "error";
			requestId: number;
			code: LayoutErrorCode;
			message: string;
	  }
	| { type: "cancelled"; requestId: number };

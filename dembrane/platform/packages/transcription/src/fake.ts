import { regexRedactPii } from "./pii";
import type {
  RedactTextInput,
  TimedText,
  TranscribeInput,
  TranscribeResult,
  Transcriber,
} from "./transcriber";

/**
 * A transcriber for tests: answers from a function of the input, records every call,
 * and can be told to fail the next calls.
 */
export class FakeTranscriber implements Transcriber {
  readonly calls: TranscribeInput[] = [];
  /** Every redactText call; the model pass counts as made when a flag was on. */
  readonly redactCalls: RedactTextInput[] = [];
  private failures: Error[] = [];

  constructor(
    private readonly answer: (input: TranscribeInput, n: number) => string = (i) =>
      `transcript of ${i.audio.byteLength} bytes`,
    /** Timed sentences to return beside the text, as Whisper's live path does. */
    private readonly timed?: (
      input: TranscribeInput,
      text: string,
    ) => TimedText | undefined | Promise<TimedText | undefined>,
  ) {}

  failNext(...errors: Error[]): void {
    this.failures.push(...errors);
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    this.calls.push(input);
    const fail = this.failures.shift();
    if (fail) throw fail;
    const text = this.answer(input, this.calls.length);
    const segments = await this.timed?.(input, text);
    return {
      transcript: text === "" ? "[Nothing to transcribe]" : text,
      note: "",
      models: ["fake"],
      ...(segments && { segments }),
    };
  }

  async redactText(input: RedactTextInput): Promise<TranscribeResult> {
    this.redactCalls.push(input);
    const fail = this.failures.shift();
    if (fail) throw fail;
    const text = input.anonymizeTranscripts ? regexRedactPii(input.text) : input.text;
    return { transcript: text, note: "", models: ["fake"] };
  }
}

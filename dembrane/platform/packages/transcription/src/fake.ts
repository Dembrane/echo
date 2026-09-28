import type { TranscribeInput, TranscribeResult, Transcriber } from "./transcriber";

/**
 * A transcriber for tests: answers from a function of the input, records every call,
 * and can be told to fail the next calls.
 */
export class FakeTranscriber implements Transcriber {
  readonly calls: TranscribeInput[] = [];
  private failures: Error[] = [];

  constructor(
    private readonly answer: (input: TranscribeInput, n: number) => string = (i) =>
      `transcript of ${i.audio.byteLength} bytes`,
  ) {}

  failNext(...errors: Error[]): void {
    this.failures.push(...errors);
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    this.calls.push(input);
    const fail = this.failures.shift();
    if (fail) throw fail;
    const text = this.answer(input, this.calls.length);
    return {
      transcript: text === "" ? "[Nothing to transcribe]" : text,
      note: "",
      models: ["fake"],
    };
  }
}

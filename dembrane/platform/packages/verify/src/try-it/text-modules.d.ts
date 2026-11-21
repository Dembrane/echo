// The sample transcripts are imported as text (Bun's `with { type: "text" }`), so they
// ship inside the compiled API with the code that reads them.
declare module "*.txt" {
  const text: string;
  export default text;
}

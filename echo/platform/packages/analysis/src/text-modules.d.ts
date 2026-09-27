// Prompt files are imported as text (Bun's `with { type: "text" }`), so they ship inside
// the compiled binary and a prompt edit is a reviewed change to a versioned file.
declare module "*.md" {
  const text: string;
  export default text;
}

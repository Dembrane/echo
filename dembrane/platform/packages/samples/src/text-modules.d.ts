// The sample report is imported as text (Bun's `with { type: "text" }`), so it ships
// inside the compiled migrate binary with the rest of the fixture.
declare module "*.md" {
  const text: string;
  export default text;
}

// The offer's fonts and images are imported as files (Bun's `with { type: "file" }`), so they
// ship inside the compiled API binary and the import is the path to read them from.
declare module "*.ttf" {
  const path: string;
  export default path;
}

declare module "*.png" {
  const path: string;
  export default path;
}

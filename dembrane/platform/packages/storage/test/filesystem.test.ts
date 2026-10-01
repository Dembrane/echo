import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemStorage } from "../src";
import { storageContract } from "./contract";

const root = mkdtempSync(join(tmpdir(), "echo-storage-"));
storageContract("filesystem", () => new FilesystemStorage(root, "http://localhost:8080"));

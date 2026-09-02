import { readFile } from "node:fs/promises";
import type { Tool } from "./tool";

interface ReadFileInput {
  readonly path: string;
}

function isReadFileInput(input: unknown): input is ReadFileInput {
  return typeof input === "object" && input !== null && typeof (input as { path?: unknown }).path === "string";
}

/**
 * An example Tool: reads a UTF-8 text file from disk. This is a real
 * adapter — the I/O that Core is deliberately kept free of lives here.
 */
export const readFileTool: Tool = {
  name: "read-file",
  description: "Reads the contents of a UTF-8 text file at the given path.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  async execute(input: unknown): Promise<string> {
    if (!isReadFileInput(input)) {
      throw new Error('read-file tool requires an input of the shape { "path": string }');
    }
    return readFile(input.path, "utf-8");
  },
};

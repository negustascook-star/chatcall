import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    return await readJson<T>(file);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function writeTextAtomic(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, file);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendText(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, contents, "utf8");
}

export async function listDirectories(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

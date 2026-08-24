import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface FileSnapshot {
  exists: boolean;
  contents?: Buffer;
  mode?: number;
}

export function expandHome(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

export function paseoCodingPlanHome(): string {
  if (process.env.PASEO_CODING_PLAN_HOME?.trim()) {
    return expandHome(process.env.PASEO_CODING_PLAN_HOME);
  }
  const paseoHome = process.env.PASEO_HOME?.trim()
    ? expandHome(process.env.PASEO_HOME)
    : path.join(homedir(), ".paseo");
  return path.join(paseoHome, "coding-plan-manager");
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

export async function readFileIfExists(
  filePath: string,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<Buffer | undefined> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    if (info.size > maxBytes) throw new Error(`File is too large: ${filePath}`);
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readTextIfExists(
  filePath: string,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<string | undefined> {
  const contents = await readFileIfExists(filePath, maxBytes);
  return contents?.toString("utf8");
}

export function parseJsonObject(text: string, description: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${description} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function rejectSymlink(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic link: ${filePath}`);
    }
    if (!info.isFile()) throw new Error(`Not a regular file: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function captureFile(filePath: string): Promise<FileSnapshot> {
  const contents = await readFileIfExists(filePath);
  if (!contents) return { exists: false };
  const info = await stat(filePath);
  return { exists: true, contents, mode: info.mode & 0o777 };
}

export async function atomicWriteFile(
  filePath: string,
  contents: string | Buffer,
  requestedMode?: number,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await rejectSymlink(filePath);

  let mode = requestedMode;
  if (mode === undefined) {
    try {
      mode = (await stat(filePath)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mode = 0o600;
    }
  }

  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temporary, mode);
    await rename(temporary, filePath);
    renamed = true;
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(filePath), "r").catch(() => undefined);
      try {
        await directory?.sync().catch(() => undefined);
      } finally {
        await directory?.close().catch(() => undefined);
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

export async function restoreFile(filePath: string, snapshot: FileSnapshot): Promise<void> {
  if (snapshot.exists && snapshot.contents) {
    await atomicWriteFile(filePath, snapshot.contents, snapshot.mode ?? 0o600);
    return;
  }
  try {
    await rejectSymlink(filePath);
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function findExecutable(name: string): Promise<string | undefined> {
  const searchPath = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];

  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const cleanDirectory = directory.replace(/^"|"$/g, "");
    for (const extension of extensions) {
      const candidate = path.join(cleanDirectory, `${name}${extension.toLowerCase()}`);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        const info = await stat(candidate);
        if (info.isFile()) return candidate;
      } catch {
        if (process.platform === "win32" && extension !== extension.toUpperCase()) {
          const upperCandidate = path.join(cleanDirectory, `${name}${extension.toUpperCase()}`);
          try {
            await access(upperCandidate, constants.F_OK);
            const info = await stat(upperCandidate);
            if (info.isFile()) return upperCandidate;
          } catch {
            // Continue scanning PATH.
          }
        }
      }
    }
  }
  return undefined;
}

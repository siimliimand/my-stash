import { AppData } from "./types";
import { AppDataSchema } from "./schemas";

const STORAGE_KEY = "my-stash-data";
const SCHEMA_VERSION = 1;

let writeTimer: ReturnType<typeof setTimeout> | null = null;

export function readStorage(): AppData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const result = AppDataSchema.safeParse(parsed);
    if (!result.success) {
      console.warn("Storage validation failed:", result.error.flatten());
      return null;
    }
    return result.data as AppData;
  } catch (err) {
    console.error("Failed to read from localStorage:", err);
    return null;
  }
}

export function writeStorage(data: AppData): void {
  if (typeof window === "undefined") return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      console.error("Failed to write to localStorage:", err);
    }
  }, 400);
}

export function writeStorageImmediate(data: AppData): void {
  if (typeof window === "undefined") return;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (err) {
    console.error("Failed to write to localStorage:", err);
  }
}

export function getRawStorage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearStorage(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // noop
  }
}

export function exportData(data: AppData): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `my-stash-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function importData(file: File): Promise<AppData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target?.result as string);
        const result = AppDataSchema.safeParse(parsed);
        if (!result.success) {
          reject(new Error("Invalid file format: " + result.error.message));
          return;
        }
        resolve(result.data as AppData);
      } catch {
        reject(new Error("Could not parse JSON file"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

export { SCHEMA_VERSION };

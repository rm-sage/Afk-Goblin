import { isBuiltinTone, parseUploadRef } from "~/alerting/tones";

export type SoundResolution =
  | { kind: "builtin"; name: string }
  | { kind: "custom"; name: string }
  /** An imported reference whose audio has not been supplied yet. */
  | { kind: "missing"; name: string };

/**
 * The display name a stored sound refers to.
 *
 * AfkWarden custom sounds are `upload:<id>:<label>` pointing at files on
 * runeapps.org. The id is meaningless here, but the label is exactly the source
 * filename the user uploaded — so matching on it reconnects an imported alert to
 * the same .wav without any server round trip.
 */
export function soundLabel(sound: string): string {
  return parseUploadRef(sound)?.label ?? sound;
}

/** Filenames come with an extension; the stored label does not. */
export function labelFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

export function resolveSound(sound: string, available: ReadonlySet<string>): SoundResolution {
  const label = soundLabel(sound);
  if (available.has(label)) return { kind: "custom", name: label };
  if (isBuiltinTone(sound)) return { kind: "builtin", name: sound };
  // An imported upload: ref with no audio yet. Named rather than silently
  // rewritten, so the UI can offer to supply the file.
  return { kind: "missing", name: label };
}

// Renamed with the project. Nothing is orphaned by this: storage is per-origin,
// and the move from Alt1's CEF profile to Bolt's is already a fresh database, so
// custom sounds have to be re-imported either way.
const DB_NAME = "afkgoblin";
const DB_VERSION = 1;
const STORE = "sounds";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = fn(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
      }),
  );
}

/**
 * User-supplied alert sounds, stored as blobs.
 *
 * AfkWarden hosts these on runeapps.org and refers to them by upload id, which
 * means its alerts stop making noise the moment that server is unreachable.
 * Holding the audio locally removes the dependency entirely.
 */
export class SoundLibrary {
  #urls = new Map<string, string>();
  #names = new Set<string>();

  get names(): ReadonlySet<string> {
    return this.#names;
  }

  async load(): Promise<void> {
    try {
      const keys = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
      this.#names = new Set(keys.map(String));
    } catch {
      // No IndexedDB (or blocked): custom sounds are simply unavailable, and
      // resolveSound falls back to a built-in tone rather than silence.
      this.#names = new Set();
    }
  }

  async add(name: string, blob: Blob): Promise<void> {
    await tx("readwrite", (s) => s.put(blob, name));
    this.#names.add(name);
    this.#revoke(name);
  }

  async remove(name: string): Promise<void> {
    await tx("readwrite", (s) => s.delete(name));
    this.#names.delete(name);
    this.#revoke(name);
  }

  #revoke(name: string): void {
    const url = this.#urls.get(name);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      this.#urls.delete(name);
    }
  }

  /** Object URL for a stored sound, fetching it into the cache on first use. */
  urlFor(sound: string): string | null {
    const resolved = resolveSound(sound, this.#names);
    if (resolved.kind !== "custom") return null;

    const cached = this.#urls.get(resolved.name);
    if (cached !== undefined) return cached;

    // Warm the cache for the next trigger. The first firing of a given sound
    // falls back to a built-in tone rather than blocking the tick on IO.
    void tx<Blob | undefined>("readonly", (s) => s.get(resolved.name)).then((blob) => {
      if (blob !== undefined) this.#urls.set(resolved.name, URL.createObjectURL(blob));
    });
    return null;
  }
}

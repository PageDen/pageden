import { access, lstat, mkdir, open, readdir, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { StorageNotFoundError, type StorageBackend, type StoredObject } from "./backend.js";

// Local filesystem store rooted at `root`. Writes go via temp file -> fsync -> atomic
// rename, so a destination object is never partially written and a crash/retry cannot
// create a divergent file (content-addressing makes a concurrent-writer race safe).
export class FsBackend implements StorageBackend {
  constructor(private readonly root: string) {}

  private abs(key: string): string {
    return join(this.root, key);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async writeAtomic(key: string, write: (h: Awaited<ReturnType<typeof open>>) => Promise<void>): Promise<void> {
    const destination = this.abs(key);
    if (await this.exists(destination)) {
      // Dedupe: refresh mtime so a concurrent orphan sweep treats it as freshly written.
      const now = new Date();
      await utimes(destination, now, now).catch(() => {});
      return;
    }
    await mkdir(dirname(destination), { recursive: true });
    const tempPath = `${destination}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let renamed = false;
    try {
      const handle = await open(tempPath, "w");
      try {
        await write(handle);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(tempPath, destination);
        renamed = true;
      } catch (error) {
        if (!(await this.exists(destination))) throw error;
      }
      try {
        const dirHandle = await open(dirname(destination), "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
        // directory fsync is best-effort and unsupported on some platforms
      }
    } finally {
      if (!renamed) await unlink(tempPath).catch(() => {});
    }
  }

  async putText(key: string, text: string): Promise<void> {
    await this.writeAtomic(key, (h) => h.writeFile(text, "utf8"));
  }

  async putBytes(key: string, data: Buffer): Promise<void> {
    await this.writeAtomic(key, (h) => h.writeFile(data));
  }

  async getText(key: string): Promise<string> {
    try {
      return await readFile(this.abs(key), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async getBytes(key: string): Promise<Buffer> {
    try {
      return await readFile(this.abs(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new StorageNotFoundError(key);
      throw err;
    }
  }

  async statMtime(key: string): Promise<number | null> {
    try {
      return (await stat(this.abs(key))).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    const toPosix = (abs: string) => relative(this.root, abs).split(/[\\/]/).join("/");
    const walk = async (dir: string): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const abs = join(dir, name);
        try {
          const info = await lstat(abs);
          if (info.isSymbolicLink()) continue; // never follow symlinks into/out of the tree
          if (info.isDirectory()) await walk(abs);
          else if (info.isFile()) out.push({ key: toPosix(abs), mtimeMs: info.mtimeMs });
        } catch {
          // unreadable entry — skip
        }
      }
    };
    await walk(join(this.root, prefix.replace(/\/+$/, "")));
    return out;
  }

  async remove(key: string): Promise<void> {
    try {
      await unlink(this.abs(key));
    } catch {
      // already gone — ignore
    }
  }
}

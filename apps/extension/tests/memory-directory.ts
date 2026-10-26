const notFound = () => new DOMException("Not found", "NotFoundError");

/** The parts of the File System Access API the folder uses; a write lands only on close. */
export class MemoryDirectory {
  readonly folders = new Map<string, MemoryDirectory>();
  readonly files = new Map<string, string>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let folder = this.folders.get(name);
    if (!folder && (this.files.has(name) || !options?.create)) throw notFound();
    folder ??= new MemoryDirectory();
    this.folders.set(name, folder);
    return folder;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name) && !options?.create) throw notFound();
    let pending = this.files.get(name) ?? "";
    return {
      getFile: async () => new File([this.files.get(name) ?? ""], name),
      createWritable: async () => ({
        write: async (data: string) => void (pending = data),
        close: async () => void this.files.set(name, pending),
      }),
    };
  }

  async removeEntry(name: string) {
    if (!this.files.delete(name) && !this.folders.delete(name)) throw notFound();
  }

  async *keys() {
    yield* [...this.folders.keys(), ...this.files.keys()];
  }

  folder(...path: string[]): MemoryDirectory {
    return path.reduce<MemoryDirectory>((at, name) => {
      const next = at.folders.get(name) ?? new MemoryDirectory();
      at.folders.set(name, next);
      return next;
    }, this);
  }

  /** Drops a file in, as another profile would; anything but a string is written as JSON. */
  drop(name: string, content: unknown) {
    this.files.set(name, typeof content === "string" ? content : JSON.stringify(content));
  }
}

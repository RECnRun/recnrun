// Types of owner-files.js for the Node tests of the owner page's folder I/O.
export interface FolderHandle {
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FolderHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<unknown>;
  removeEntry(name: string): Promise<void>;
  values(): AsyncIterable<unknown>;
}
export type Failure =
  | { status: "missing" | "folder-missing" | "denied" }
  | { status: "error"; message: string };
export type ReadResult = { status: "ok"; bytes: Uint8Array } | Failure;
export type WriteResult = { status: "ok" } | Failure;
export declare const readFile: (root: FolderHandle, path: string) => Promise<ReadResult>;
export declare const writeFile: (
  root: FolderHandle,
  path: string,
  bytes: Uint8Array,
) => Promise<WriteResult>;
export declare const removeFile: (root: FolderHandle, path: string) => Promise<WriteResult>;
export declare const readMarker: (
  root: FolderHandle,
) => Promise<{ marker: "ok" | "missing" | "invalid" | "folder-missing"; workspaceId?: string }>;
export declare const pickFolder: (picker: () => Promise<unknown>) => Promise<unknown>;
export declare const ensureMarker: (root: FolderHandle) => Promise<{
  marker: "ok" | "folder-missing" | "denied" | "error";
  workspaceId?: string;
}>;

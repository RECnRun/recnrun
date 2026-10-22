/** Carries bridge messages without knowing their shape; tests swap in an in-memory one. */
export interface Transport {
  send(message: unknown): void;
  subscribe(listener: (message: unknown) => void): () => void;
}

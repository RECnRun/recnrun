// Types of input-client.js for the Node tests of the master's input.v1 client.
export interface InputLink {
  pc: { createDataChannel: (label: string, options?: object) => unknown };
}
export declare const createInput: (options: {
  links: Map<string, InputLink>;
  onRevoked?: (name: string, message: unknown) => void;
}) => {
  interactRaw: (name: string, message: { type: string }) => Promise<{ ok: boolean }>;
};

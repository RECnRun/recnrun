import { type CommandName, SERVICE_COMMANDS, type ServiceMessage } from "@recnrun/protocol";
import type { Output } from "@/api/schema";

/** Every command the UI sends, with the protocol's params and result schemas. */
export const UI_COMMANDS = SERVICE_COMMANDS;

export type UiCommand = CommandName;
export type Params<C extends UiCommand> = Output<(typeof UI_COMMANDS)[C]["params"]>;
export type Result<C extends UiCommand> = Output<(typeof UI_COMMANDS)[C]["result"]>;

/** Messages the service pushes over the WebSocket, keyed by their `type`. */
export type PushType = ServiceMessage["type"];
export type PushMessage<T extends PushType> = Extract<ServiceMessage, { type: T }>;

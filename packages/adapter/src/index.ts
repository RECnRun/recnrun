export { createCdpAdapter, type AdapterDependencies } from "./adapter.ts";
export type { CdpLink, CdpSession, CdpTransport, PageSession } from "./cdp-link.ts";
export {
  connect,
  type CdpConnection,
  type ConnectOptions,
  type ReconnectOutcome,
} from "./connection.ts";
export { discover, type DiscoverOptions, type DiscoveryFileSystem } from "./discovery.ts";
export { hookSource } from "./hook-source.ts";
export {
  instrument,
  instrumentChannel,
  type Instrumentation,
  type InstrumentOptions,
} from "./instrumentation.ts";
export type { CdpChannel, CdpEvent } from "./cdp-socket.ts";
export type { CaptureOptions } from "./capture.ts";
export {
  resolveFunctionLocator,
  type FunctionLocatorOptions,
  type FunctionLocatorResolution,
  type LocatorTarget,
} from "./function-locator.ts";
export { isLoopbackEndpoint, NonLoopbackEndpointError } from "./loopback.ts";
export { AlreadyConnectedError } from "./adapter.ts";
export { CdpOpenError, type CdpOpenFailure } from "./cdp-socket.ts";
export { startRecording, type Recording } from "./recording.ts";
export { TargetScope } from "./instrumentation-scope.ts";
export {
  PICKER_BINDING,
  PICKER_WORLD,
  pickerSource,
  startPicker,
  type Picker,
  type PickerOptions,
} from "./picker.ts";

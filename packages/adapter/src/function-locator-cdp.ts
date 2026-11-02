import type { ElementReference } from "@recnrun/protocol";
import * as v from "valibot";
import type { CdpSession } from "./cdp-link.ts";

/** The isolated world every locator function runs in; the page's own scripts never see it. */
const LOCATOR_WORLD = "__recnrun_locator";

export interface FrameInfo {
  id: string;
  loaderId: string;
}

interface FrameNode {
  frame: FrameInfo;
  childFrames?: FrameNode[] | undefined;
}

const FrameNodeSchema: v.GenericSchema<unknown, FrameNode> = v.object({
  frame: v.object({ id: v.string(), loaderId: v.string() }),
  childFrames: v.optional(v.array(v.lazy(() => FrameNodeSchema))),
});

const RemoteObjectSchema = v.object({
  type: v.string(),
  subtype: v.optional(v.string()),
  objectId: v.optional(v.string()),
  description: v.optional(v.string()),
  value: v.optional(v.unknown()),
});

export type RemoteObject = v.InferOutput<typeof RemoteObjectSchema>;

/** A `Runtime.evaluate` or `Runtime.callFunctionOn` reply. */
export const EvaluationSchema = v.object({
  result: RemoteObjectSchema,
  exceptionDetails: v.optional(
    v.object({ text: v.string(), exception: v.optional(RemoteObjectSchema) }),
  ),
});

export type Evaluation = v.InferOutput<typeof EvaluationSchema>;

const FrameTreeReplySchema = v.object({ frameTree: FrameNodeSchema });
const WorldReplySchema = v.object({ executionContextId: v.number() });
const PropertiesReplySchema = v.object({
  result: v.array(v.object({ name: v.string(), value: v.optional(RemoteObjectSchema) })),
});
const DescribeReplySchema = v.object({ node: v.object({ backendNodeId: v.number() }) });

function findIn(node: FrameNode, frameId: string): FrameInfo | undefined {
  if (node.frame.id === frameId) return node.frame;
  for (const child of node.childFrames ?? []) {
    const found = findIn(child, frameId);
    if (found) return found;
  }
  return undefined;
}

/** The frame a locator runs in: the one named, or the target's main frame. */
export async function findFrame(session: CdpSession, frameId?: string): Promise<FrameInfo> {
  const { frameTree } = v.parse(FrameTreeReplySchema, await session.send("Page.getFrameTree"));
  const frame = frameId === undefined ? frameTree.frame : findIn(frameTree, frameId);
  if (!frame) throw new Error(`The target has no frame ${frameId}.`);
  return { id: frame.id, loaderId: frame.loaderId };
}

export async function createWorld(session: CdpSession, frameId: string): Promise<number> {
  const reply = await session.send("Page.createIsolatedWorld", {
    frameId,
    worldName: LOCATOR_WORLD,
    grantUniveralAccess: false,
  });
  return v.parse(WorldReplySchema, reply).executionContextId;
}

/** The text a thrown value shows: an Error's first line, or the thrown value itself. */
export function exceptionText(details: NonNullable<Evaluation["exceptionDetails"]>): string {
  const thrown = details.exception;
  const value = thrown?.value;
  const shown = typeof value === "string" ? value : JSON.stringify(value);
  const text = thrown?.description ?? (value === undefined ? details.text : shown);
  return text.split("\n")[0] || details.text;
}

/** The object ids of an array's items, in index order. */
export async function arrayItems(session: CdpSession, objectId: string): Promise<string[]> {
  const reply = await session.send("Runtime.getProperties", { objectId, ownProperties: true });
  return v
    .parse(PropertiesReplySchema, reply)
    .result.filter(({ name }) => /^\d+$/.test(name))
    .toSorted((a, b) => Number(a.name) - Number(b.name))
    .flatMap(({ value }) => (value?.objectId ? [value.objectId] : []));
}

async function backendNodeIdOf(session: CdpSession, objectId: string): Promise<number> {
  const reply = await session.send("DOM.describeNode", { objectId });
  return v.parse(DescribeReplySchema, reply).node.backendNodeId;
}

/** Element references for these handles, without duplicates; the handles of duplicates are returned too. */
export async function describeElements(
  session: CdpSession,
  scope: { targetId: string; frame: FrameInfo },
  objectIds: string[],
): Promise<{ references: ElementReference[]; duplicates: string[] }> {
  const references: ElementReference[] = [];
  const duplicates: string[] = [];
  for (const objectId of objectIds) {
    const backendNodeId = await backendNodeIdOf(session, objectId);
    if (references.some((each) => each.backendNodeId === backendNodeId)) {
      duplicates.push(objectId);
      continue;
    }
    const { targetId, frame } = scope;
    references.push({
      targetId,
      frameId: frame.id,
      loaderId: frame.loaderId,
      objectId,
      backendNodeId,
    });
  }
  return { references, duplicates };
}

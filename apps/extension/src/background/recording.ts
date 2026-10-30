import type { RecordingStatus, StartResult, Step, StepDraft, Workflow } from "@recnrun/domain";
import {
  bindRecording,
  findRecordingGroup,
  readRecordings,
  unbindRecording,
} from "@/storage/recordings-repository";
import type { RecordingBinding } from "@/storage/recordings-repository";
import type { WorkflowStore } from "@/storage/workflow-store";
import type { BrowserAdapter, TabInfo } from "./browser-adapter.ts";
import { originOf, originPattern } from "./origin-patterns.ts";
import { ensureGroup, missingOrigins, recordableTabs, resolveTab, tabsOf } from "./tab-groups.ts";
import type { Caller } from "./tab-groups.ts";

export type { Caller } from "./tab-groups.ts";
import type { Notify } from "./timeline-ports.ts";

export interface RecordingDependencies {
  browser: BrowserAdapter;
  store: WorkflowStore;
  now: () => string;
  newId: () => string;
  notify: Notify;
}

async function requireWorkflow(store: WorkflowStore, id: string): Promise<Workflow> {
  const workflow = await store.getWorkflow(id);
  if (!workflow) throw new Error(`No workflow ${id}.`);
  return workflow;
}

export async function statusOf(
  deps: RecordingDependencies,
  tab: TabInfo,
  dashboardOrigin: string | undefined,
): Promise<RecordingStatus> {
  const binding = (await readRecordings()).get(tab.groupId);
  const workflow = binding ? await deps.store.getWorkflow(binding.workflowId) : undefined;
  const tabs = await tabsOf(deps.browser, tab);
  const missing = await missingOrigins(deps.browser, tabs, dashboardOrigin);
  return { ...(workflow ? { workflow } : {}), missingOrigins: missing };
}

/** Registers the recorder for the granted origins while anything records, else unregisters it. */
export async function sync({ browser }: RecordingDependencies): Promise<void> {
  const recordings = await readRecordings();
  if (recordings.size === 0) return browser.unregisterRecorder();
  await browser.registerRecorder(await browser.grantedOrigins());
  for (const [groupId, binding] of recordings) {
    const tabs = recordableTabs(await browser.groupTabs(groupId), binding.dashboardOrigin);
    for (const tab of tabs.filter((candidate) => candidate.loaded)) {
      await browser.injectRecorder(tab.id).catch(() => undefined);
    }
  }
}

async function refuseIfRecording(deps: RecordingDependencies, groupId: number): Promise<void> {
  const current = (await readRecordings()).get(groupId);
  if (!current) return;
  const title = (await deps.store.getWorkflow(current.workflowId))?.title ?? current.workflowId;
  throw new Error(`This tab group is already recording "${title}".`);
}

/** Shared by start and resume: group, check origins, open the URL, bind, and arm. */
export async function begin(
  deps: RecordingDependencies,
  workflow: Workflow,
  caller: Caller,
  url?: string,
): Promise<StartResult> {
  const { browser, store, now, notify } = deps;
  const tab = await resolveTab(browser, caller);
  const groupId = await ensureGroup(browser, tab);
  await refuseIfRecording(deps, groupId);
  const tabs = await browser.groupTabs(groupId);
  const missing = await missingOrigins(browser, tabs, caller.dashboardOrigin, url);
  if (missing.length > 0) return { status: "permission-required", origins: missing };
  if (url !== undefined) {
    const opened = await browser.createTab(url, tab.windowId);
    await browser.addToGroup([opened.id], groupId);
  }
  const recording: Workflow = { ...workflow, status: "recording", updatedAt: now() };
  await store.putWorkflow(recording);
  const binding: RecordingBinding = { workflowId: recording.id };
  if (caller.dashboardOrigin !== undefined) binding.dashboardOrigin = caller.dashboardOrigin;
  await bindRecording(groupId, binding);
  await sync(deps);
  notify({ name: "recordingChanged", data: { workflow: recording, missingOrigins: [] } }, groupId);
  return { status: "recording", workflow: recording };
}

export async function stopGroup(
  deps: RecordingDependencies,
  groupId: number,
  binding: RecordingBinding,
): Promise<Workflow> {
  const { browser, store, now, notify } = deps;
  const workflow = await requireWorkflow(store, binding.workflowId);
  const stopped: Workflow = { ...workflow, status: "stopped", updatedAt: now() };
  await store.putWorkflow(stopped);
  await unbindRecording(groupId);
  await sync(deps);
  const tabs = recordableTabs(await browser.groupTabs(groupId), binding.dashboardOrigin);
  const missing = await missingOrigins(browser, tabs, binding.dashboardOrigin);
  notify({ name: "recordingChanged", data: { missingOrigins: missing } }, groupId);
  return stopped;
}

/** Stops the workflow wherever it records; an already stopped one is returned unchanged. */
export async function stopById(deps: RecordingDependencies, id: string): Promise<Workflow> {
  const groupId = await findRecordingGroup(id);
  const binding = groupId === undefined ? undefined : (await readRecordings()).get(groupId);
  if (groupId === undefined || !binding) return requireWorkflow(deps.store, id);
  return stopGroup(deps, groupId, binding);
}

export async function appendStep(
  deps: RecordingDependencies,
  draft: StepDraft,
  binding: RecordingBinding,
  tabId: number,
): Promise<Step> {
  const step: Step = { ...draft, id: deps.newId(), workflowId: binding.workflowId, tabId };
  await deps.store.appendStep(step);
  deps.notify({ name: "stepRecorded", data: step }, undefined);
  return step;
}

/** A tab of a recording group changed URL: a `navigate` step, and a warning if it left granted origins. */
export async function recordNavigation(
  deps: RecordingDependencies,
  tab: TabInfo,
  url: string,
): Promise<void> {
  const binding = (await readRecordings()).get(tab.groupId);
  const pattern = originPattern(url);
  if (!binding || pattern === undefined || originOf(url) === binding.dashboardOrigin) return;
  const draft: StepDraft = {
    recordedAt: deps.now(),
    url,
    author: "browser",
    command: "navigate",
    value: url,
  };
  await appendStep(deps, draft, binding, tab.id);
  if (!(await deps.browser.hasOrigin(pattern))) {
    const status = await statusOf(deps, tab, binding.dashboardOrigin);
    deps.notify({ name: "recordingChanged", data: status }, tab.groupId);
  }
}

export async function resumeWorkflow(
  deps: RecordingDependencies,
  id: string,
  caller: Caller,
): Promise<StartResult> {
  const workflow = await requireWorkflow(deps.store, id);
  if ((await findRecordingGroup(id)) !== undefined) {
    throw new Error(`"${workflow.title}" is already recording.`);
  }
  return begin(deps, workflow, caller);
}

/** Needs a user gesture, so only the popup and the website call it; the public API cannot. */
export async function grantOrigins(
  deps: RecordingDependencies,
  origins: string[],
  caller: Caller,
): Promise<{ granted: boolean }> {
  const granted = await deps.browser.requestOrigins(origins);
  if (!granted) return { granted };
  await sync(deps);
  const tab = await resolveTab(deps.browser, caller);
  const status = await statusOf(deps, tab, caller.dashboardOrigin);
  deps.notify({ name: "recordingChanged", data: status }, tab.groupId);
  return { granted };
}

export async function deleteWorkflow(deps: RecordingDependencies, id: string): Promise<void> {
  const workflow = await requireWorkflow(deps.store, id);
  if ((await findRecordingGroup(id)) !== undefined) {
    throw new Error(`Stop "${workflow.title}" before deleting it.`);
  }
  await deps.store.deleteWorkflow(id);
}

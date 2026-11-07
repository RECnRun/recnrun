import type { Page } from "@playwright/test";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import type { InputReply } from "./interact-harness.ts";
import { background, call, until } from "./lifecycle-harness.ts";
import { NAME } from "./trust-harness.ts";

/* Helpers of the W7 slice B cells: frames the master can aim at, and clicks on its image. */

interface Geometry {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  offsetTop: number;
}

export interface SentFrame {
  frameSeq: number;
  bootId: string;
  sessionEpoch: number;
  loaderId: string;
  geometry: Geometry | null;
}

export interface Point {
  x: number;
  y: number;
}

export interface TabState {
  tab: { tabId: number; loaderId: string; url: string } | null;
  tabStats: { opened: number; closed: number; openersClosed: number; refreshes: number };
  stats: { dispatched: number; framesSent: number };
}

interface ImageBox {
  left: number;
  top: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

/** The frame the master's image shows now, as the worker announced it on input.v1. */
const shown = (page: Page, name = NAME) =>
  page.evaluate((link) => {
    type Lab = Record<"shownFrame" | "interactFrame", (...x: unknown[]) => unknown>;
    const { lab } = window as unknown as { lab: Lab };
    const frameSeq = lab.shownFrame(link);
    return frameSeq ? lab.interactFrame(link, frameSeq) : null;
  }, name) as Promise<SentFrame | null>;

/** Waits for a shown screencast frame, optionally one `differs` accepts. */
export const aimable = (page: Page, differs: (frame: SentFrame) => boolean = () => true) =>
  until(
    () => shown(page),
    (frame) => Boolean(frame?.geometry) && differs(frame as SentFrame),
    10_000,
  ) as Promise<SentFrame>;

/** Lays the image out in an 800×600 box with `contain`, so a 16:9 frame is letterboxed. */
export const letterbox = (page: Page) =>
  page.evaluate(() => {
    const image = document.getElementById("visual") as HTMLImageElement;
    const style = { position: "fixed", left: "0", top: "0", width: "800px", height: "600px" };
    Object.assign(image.style, style, { objectFit: "contain", background: "#333", zIndex: "9" });
  });

const imageBox = (page: Page) =>
  page.evaluate(() => {
    const image = document.getElementById("visual") as HTMLImageElement;
    const { left, top, width, height } = image.getBoundingClientRect();
    const lab = (window as unknown as { lab: { interactView: () => { natural: object } } }).lab;
    const natural = lab.interactView().natural as { width: number; height: number };
    return { left, top, width, height, naturalWidth: natural.width, naturalHeight: natural.height };
  }) as Promise<ImageBox>;

/** Clicks the master's image where the frame's normalized `point` is drawn, as a person would. */
export async function clickAt(page: Page, point: Point): Promise<void> {
  const box = await imageBox(page);
  const scale = Math.min(box.width / box.naturalWidth, box.height / box.naturalHeight);
  const width = box.naturalWidth * scale;
  const height = box.naturalHeight * scale;
  const x = box.left + (box.width - width) / 2 + point.x * width;
  const y = box.top + (box.height - height) / 2 + point.y * height;
  await page.mouse.click(x, y);
}

/** The fields that aim an event at `frame`, at `point` over its image. */
export const aimedAt = (frame: SentFrame, point: Point = { x: 0.5, y: 0.5 }) => ({
  bootId: frame.bootId,
  sessionEpoch: frame.sessionEpoch,
  frameSeq: frame.frameSeq,
  loaderId: frame.loaderId,
  ...point,
});

export const pointer = (page: Page, kind: string, fields: object, name = NAME) =>
  call<InputReply>(page, "interactEvent", name, kind, fields);
export const tabState = (worker: LoadedExtension) =>
  background<TabState>(worker, "lab.interact.state()");
export const framesSent = async (worker: LoadedExtension) =>
  (await tabState(worker)).stats.framesSent;

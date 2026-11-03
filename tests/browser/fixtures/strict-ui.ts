import { focus, xdotool } from "./x-display.ts";

/*
 * The strict lab's keyboard (E8): with no CDP client, navigation is what a person types in the
 * container's Chrome window. No long option is passed (see x-display.ts).
 */

/** Types `url` in the omnibox of window `id` and goes there; Delete drops an inline completion. */
export async function navigate(id: string, url: string): Promise<void> {
  await focus(id);
  await xdotool("key", "ctrl+l");
  await xdotool("type", url);
  await xdotool("key", "Delete");
  await xdotool("key", "Return");
}

/** Presses `keys` in window `id`, one chord after the other. */
export async function press(id: string, ...keys: string[]): Promise<void> {
  await focus(id);
  for (const key of keys) await xdotool("key", key);
}

export const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].find((each) => each.textContent === name);

export const panelText = (scope: ParentNode) =>
  scope.querySelector('section[aria-label="Recording panel"]')?.textContent;

export const field = (scope: ParentNode, id: string) =>
  scope.querySelector<HTMLInputElement>(`#${id}`) ?? undefined;

/** Types as the user would, and waits for the render, so the next click sees the text. */
export async function type(target: HTMLInputElement | undefined, text: string) {
  if (!target) throw new Error("Nothing to type into.");
  target.value = text;
  target.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve));
}

import { MAX_CAPTURED_TEXT } from "@recnrun/protocol";

/** Records whether anything was clipped or dropped, and passes that on to the enclosing part. */
export class Cut {
  any = false;

  text(value: string): string {
    if (value.length > MAX_CAPTURED_TEXT) this.any = true;
    return value.slice(0, MAX_CAPTURED_TEXT);
  }

  list<T>(items: readonly T[], max: number): T[] {
    if (items.length > max) this.any = true;
    return items.slice(0, max);
  }

  flag(parent?: Cut): { truncated?: true } {
    if (this.any && parent) parent.any = true;
    return this.any ? { truncated: true } : {};
  }
}

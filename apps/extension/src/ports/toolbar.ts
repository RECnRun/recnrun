/** Whether the user pinned RECnRun's icon to the toolbar, which no extension API can do for them. */
export interface ToolbarPin {
  pinned: () => Promise<boolean>;
  /** Calls back when the user pins or unpins RECnRun; returns the unsubscribe function. */
  watch: (onChange: (pinned: boolean) => void) => () => void;
}

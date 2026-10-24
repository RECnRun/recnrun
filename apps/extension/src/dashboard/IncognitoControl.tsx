import { useEffect, useState } from "preact/hooks";
import type { IncognitoAccess } from "@/tabs/open-tabs";
import { errorText } from "@/views/recording";

/** Opens an incognito window when RECnRun may see it, or says how to allow that. */
export function IncognitoControl(props: {
  access: IncognitoAccess;
  onError: (text: string) => void;
}) {
  const [allowed, setAllowed] = useState<boolean>();
  useEffect(() => {
    void props.access.allowed().then(setAllowed, () => setAllowed(false));
  }, [props.access]);
  if (allowed === undefined) return null;
  if (!allowed) {
    return (
      <p class="tab-hint">
        To list incognito tabs, turn on “Allow in Incognito” in RECnRun’s extension details.
      </p>
    );
  }
  const open = () =>
    props.access.openWindow().catch((caught: unknown) => props.onError(errorText(caught)));
  return (
    <button type="button" class="tab-new-window" onClick={() => void open()}>
      New incognito window
    </button>
  );
}

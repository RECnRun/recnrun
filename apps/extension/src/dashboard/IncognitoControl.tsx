import { useEffect, useState } from "preact/hooks";
import type { IncognitoAccess } from "@/tabs/open-tabs";
import { errorText } from "@/views/recording";

interface IncognitoProps {
  access: IncognitoAccess;
  onError: (text: string) => void;
}

/** Leads to RECnRun's details, since only Chrome may turn on "Allow in Incognito". */
function IncognitoBanner({ access, onError }: IncognitoProps) {
  const open = () => access.openSettings().catch((caught: unknown) => onError(errorText(caught)));
  return (
    <section class="incognito-banner" aria-labelledby="incognito-heading">
      <h3 id="incognito-heading">Enable Incognito Mode</h3>
      <p>
        Allow RECnRun to access Incognito tabs so you can record and run sessions in private
        windows.
      </p>
      <p>Open the extension settings and enable “Allow in Incognito”.</p>
      <button type="button" onClick={() => void open()}>
        Open Extension Config
      </button>
    </section>
  );
}

/** Opens an incognito window when RECnRun may see it, or leads to where to allow that. */
export function IncognitoControl(props: IncognitoProps) {
  const [allowed, setAllowed] = useState<boolean>();
  useEffect(() => {
    // A failed read says nothing about the toggle, so it shows neither the banner nor the button.
    void props.access.allowed().then(setAllowed, () => {});
  }, [props.access]);
  if (allowed === undefined) return null;
  if (!allowed) return <IncognitoBanner {...props} />;
  const open = () =>
    props.access.openWindow().catch((caught: unknown) => props.onError(errorText(caught)));
  return (
    <button type="button" class="tab-new-window" onClick={() => void open()}>
      New incognito window
    </button>
  );
}

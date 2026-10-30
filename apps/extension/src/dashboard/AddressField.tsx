import type { Identity } from "@recnrun/domain";
import { useEffect, useRef, useState } from "preact/hooks";
import { addressSuggestions } from "@/dashboard/address-suggestions";
import type { AddressSuggestion } from "@/dashboard/address-suggestions";
import type { HistoryEntry, HistorySource } from "@/ports/history";
import type { OpenTab } from "@/ports/tabs";

const LIST_ID = "address-suggestions";
const optionId = (index: number) => `address-suggestion-${index}`;
const SOURCE_NAMES = { tab: "Open tab", identity: "Saved identity", history: "History" } as const;
/** How long typing pauses before history is searched, so a word costs one search. */
const HISTORY_DELAY_MS = 150;

/** History matching `text` once typing pauses; none is searched while the list is closed. */
function useHistory(history: HistorySource, text: string, open: boolean): HistoryEntry[] {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    const timer = setTimeout(() => {
      const show = (found: HistoryEntry[]) => {
        if (current) setEntries(found);
      };
      // A failed search still leaves the tabs and identities to choose from.
      history.search(text.trim()).then(show, () => show([]));
    }, HISTORY_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [history, text, open]);
  return entries;
}

interface FieldProps {
  value: string;
  onValue: (url: string) => void;
  history: HistorySource;
  tabs: readonly OpenTab[];
  identities: readonly Identity[];
}

function Suggestion(props: {
  suggestion: AddressSuggestion;
  index: number;
  active: boolean;
  choose: () => void;
}) {
  const { suggestion, index, active, choose } = props;
  return (
    <li
      id={optionId(index)}
      role="option"
      aria-selected={active}
      // Keeps the focus in the field, so its blur does not close the list before the click.
      onMouseDown={(event) => event.preventDefault()}
      onClick={choose}
    >
      <span class="suggestion-title">{suggestion.title}</span>
      <span class="suggestion-source">{SOURCE_NAMES[suggestion.from]}</span>
      <span class="suggestion-url">{suggestion.url}</span>
    </li>
  );
}

/** The list's open state and active option, moved by the keys a combobox takes. */
function useCombobox(onValue: (url: string) => void) {
  const [open, setOpen] = useState(false);
  const [active, setActiveState] = useState(-1);
  // Keys can arrive before the next render, so each one reads the index the previous one set.
  const activeRef = useRef(-1);
  const setActive = (index: number) => {
    activeRef.current = index;
    setActiveState(index);
  };
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const choose = (suggestion: AddressSuggestion) => {
    onValue(suggestion.url);
    close();
  };
  const typed = (url: string) => {
    onValue(url);
    setOpen(true);
    setActive(-1);
  };
  const keys = (suggestions: readonly AddressSuggestion[]) => (event: KeyboardEvent) => {
    const move = (step: number) => {
      setOpen(true);
      setActive(Math.min(Math.max(activeRef.current + step, 0), suggestions.length - 1));
    };
    const chosen = suggestions[activeRef.current];
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Escape") close();
    else if (event.key === "Enter" && chosen) choose(chosen);
    else return;
    event.preventDefault();
  };
  return { open, active, close, choose, typed, keys };
}

/**
 * The Address field, a combobox over open normal tabs, saved identities, and history. Only the
 * chosen address is copied; the field stays free text.
 */
export function AddressField({ value, onValue, history, tabs, identities }: FieldProps) {
  const box = useCombobox(onValue);
  const entries = useHistory(history, value, box.open);
  const suggestions = box.open
    ? addressSuggestions(value, { tabs, identities, history: entries })
    : [];
  const shown = suggestions.length > 0;
  return (
    <div class="address-combobox">
      <label class="workspace-address">
        Address
        {/* A text type, since ARIA in HTML gives a url input without a list only the textbox role. */}
        <input
          type="text"
          inputMode="url"
          spellcheck={false}
          role="combobox"
          autocomplete="off"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={shown ? LIST_ID : undefined}
          aria-activedescendant={shown && box.active >= 0 ? optionId(box.active) : undefined}
          value={value}
          placeholder="https://"
          onInput={(event) => box.typed(event.currentTarget.value)}
          onKeyDown={box.keys(suggestions)}
          onBlur={box.close}
        />
      </label>
      {shown && (
        <ul
          id={LIST_ID}
          role="listbox"
          aria-label="Address suggestions"
          class="address-suggestions"
        >
          {suggestions.map((suggestion, index) => (
            <Suggestion
              key={suggestion.url}
              suggestion={suggestion}
              index={index}
              active={index === box.active}
              choose={() => box.choose(suggestion)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

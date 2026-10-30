import type { Workflow } from "@recnrun/domain";
import { useState } from "preact/hooks";
import { ResumePicker } from "@/popup/ResumePicker";
import { parseTags } from "@/popup/tags";

interface Props {
  stopped: Workflow[];
  onStart: (draft: { title: string; description?: string; tags: string[] }) => void;
  onResume: (id: string) => void;
}

interface FieldProps {
  name: string;
  label: string;
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
}

function Field({ name, label, value, onInput, placeholder }: FieldProps) {
  return (
    <label>
      {label}
      <input
        name={name}
        value={value}
        placeholder={placeholder}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
    </label>
  );
}

export function StartForm({ stopped, onStart, onResume }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");

  const start = (event: Event) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "") return;
    const note = description.trim();
    onStart({
      title: trimmed,
      ...(note === "" ? {} : { description: note }),
      tags: parseTags(tags),
    });
  };

  return (
    <>
      <form class="start" onSubmit={start}>
        <Field name="title" label="Title" value={title} onInput={setTitle} />
        <Field
          name="description"
          label="Description"
          value={description}
          onInput={setDescription}
        />
        <Field
          name="tags"
          label="Tags"
          placeholder="env:local feature:login"
          value={tags}
          onInput={setTags}
        />
        <button type="submit" class="button">
          Start recording
        </button>
      </form>
      <ResumePicker stopped={stopped} onResume={onResume} />
    </>
  );
}

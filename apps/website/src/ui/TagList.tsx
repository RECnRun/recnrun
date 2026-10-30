export function TagList({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul class="tags" aria-label="Tags">
      {tags.map((tag) => (
        <li key={tag} class="tag">
          {tag}
        </li>
      ))}
    </ul>
  );
}

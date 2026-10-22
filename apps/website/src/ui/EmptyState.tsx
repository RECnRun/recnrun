export function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div class="empty-state" role="status">
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  );
}

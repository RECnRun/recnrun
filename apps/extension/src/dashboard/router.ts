/** Where the dashboard keeps its route, so links, reloads, and Back work. */
export interface DashboardRouter {
  initialRoute: string;
  href(path: string): string;
  subscribe(listener: (path: string) => void): () => void;
  /** Adds a route the user opened in the dashboard to the history. */
  navigate(path: string): void;
  /** Titles the route the dashboard shows. */
  publish(path: string, title: string): void;
}

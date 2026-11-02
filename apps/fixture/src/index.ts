export interface FixtureRoute {
  readonly path: string;
}

export interface FixtureServer {
  readonly routes: readonly FixtureRoute[];
}

/** The controllable test application; F0.5 adds its routes and serves them on two ports. */
export function createFixtureServer(): FixtureServer {
  return { routes: [] };
}

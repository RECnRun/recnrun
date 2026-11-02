import { type ComponentChildren, createContext } from "preact";
import { useCallback, useContext, useEffect, useState } from "preact/hooks";
import type { Api } from "@/api/api";
import { type ApiError, toApiError } from "@/api/error";

const ApiContext = createContext<Api | undefined>(undefined);

export function ApiProvider({ api, children }: { api: Api; children: ComponentChildren }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi needs an ApiProvider.");
  return api;
}

export type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; error: ApiError };

/** Loads once per `key` and again on `reload`; an unmounted screen ignores late answers. */
export function useLoad<T>(load: (api: Api) => Promise<T>, key: string) {
  const api = useApi();
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setLoaded({ state: "loading" });
    load(api).then(
      (value) => live && setLoaded({ state: "ready", value }),
      (error: unknown) => live && setLoaded({ state: "error", error: toApiError(error) }),
    );
    return () => {
      live = false;
    };
    // `load` is a new closure every render; `key` names what it loads.
  }, [api, key, round]);
  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { loaded, setLoaded, reload };
}

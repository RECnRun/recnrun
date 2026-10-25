// The source B1 registers for a container: the prelude's parts with the container and a
// snapshot of its script-visible cookies.
import "./prelude.js";
import "./prelude-identity.js";

export const BINDING = "__rnrReport";
// The control tabs' content script installs under its own marker (control-start.js).
const MARKER = "__rnrSync";

const { install, parts } = globalThis.rnrPrelude;
delete globalThis.rnrPrelude;

/** Script-visible cookies: what `document.cookie` may show. */
const scriptCookies = (jar) => jar.filter(({ httpOnly }) => !httpOnly);

/** An expression that installs the prelude for `container`, or refreshes its cookie snapshot. */
export function preludeSource(container, jar) {
  const config = {
    container,
    cookies: scriptCookies(jar),
    marker: MARKER,
    binding: BINDING,
    control: false,
  };
  return `(${install})(${JSON.stringify(config)}, [${parts.map(String).join(",\n")}]);`;
}

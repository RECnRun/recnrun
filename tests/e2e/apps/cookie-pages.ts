// The cookie jar of the cookies POC spec: one response per Set-Cookie case, attributes as Chrome reads them.

/** Hosts whose frames the jar page embeds; `other` is the one a capture declares. */
export const FRAME_HOSTS = { declared: "other.localhost", undeclared: "ads.localhost" };

/** Every Set-Cookie of the jar page; the last ones are those Chrome must refuse. */
export const jarCookies = (run: string) => [
  `run=${run}; Path=/; HttpOnly; SameSite=Lax`,
  "h_session=v1; Path=/; HttpOnly; SameSite=Lax",
  "h_persist=v2; Path=/; Max-Age=3600; SameSite=Strict",
  "d_domain=v3; Domain=app.localhost; Path=/; SameSite=Lax",
  "shadow=root; Path=/; SameSite=Lax",
  "shadow=deep; Path=/deep; SameSite=Lax",
  "__Host-pref=v4; Path=/; Secure; SameSite=Lax",
  "__Secure-pref=v5; Path=/; Secure; SameSite=Lax",
  "none_secure=v6; Path=/; Secure; SameSite=None",
  "part_first=v7; Path=/; Secure; SameSite=None; Partitioned",
  "unspec=v8; Path=/",
  "none_plain=v9; Path=/; SameSite=None",
  "__Host-domain=v10; Domain=app.localhost; Path=/; Secure",
  "__Secure-plain=v11; Path=/",
];

/** The jar page: its own cookies, then one frame per foreign host, each setting two cookies. */
export const jarPage = `<!doctype html><title>Jar</title>${Object.values(FRAME_HOSTS)
  .map((host) => `<iframe title="${host}" src="http://${host}:5192/jar-frame"></iframe>`)
  .join("")}`;

/** A cross-site frame's cookies: a partitioned one and an unpartitioned one. */
export const frameCookies = [
  "frame_part=v12; Path=/; Secure; SameSite=None; Partitioned",
  "frame_plain=v13; Path=/; Secure; SameSite=None",
];

export const framePage = "<!doctype html><title>Frame</title><p>frame</p>";

// The four-identity workflow: each step is allowed for one fictional user, identified only by the
// session cookie the request carried.
const STEPS = {
  create: { user: "Admin", from: undefined, to: "created" },
  submit: { user: "Requester", from: "created", to: "submitted" },
  approve: { user: "Approver", from: "submitted", to: "approved" },
  complete: { user: "Supervisor", from: "approved", to: "completed" },
};

export function workflowRoutes(userOf, readBody, json) {
  const requests = new Map();
  return {
    "POST /workflow": async (request, response) => {
      const { step, id } = JSON.parse(await readBody(request));
      const rule = STEPS[step];
      const user = userOf(request);
      const current = requests.get(id);
      const allowed = rule && rule.user === user && current?.state === rule.from;
      if (!allowed) return json(response, { ok: false, user, state: current?.state ?? null });
      const history = [...(current?.history ?? []), { step, user }];
      requests.set(id, { state: rule.to, history });
      return json(response, { ok: true, user, state: rule.to });
    },
    "GET /workflow": (request, response, url) =>
      json(response, requests.get(url.searchParams.get("id")) ?? null),
  };
}

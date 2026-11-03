// E6: a session rule redirects this file to the active slot; when it runs itself, no rule applied, so it fails closed.
throw new Error("RECnRun: ns/current.js ran unredirected; no session rule selected a slot");

import { browserProject } from "../../vitest.browser.shared.ts";

export default browserProject("website", new URL(".", import.meta.url));

import { browserProject } from "../../vitest.browser.shared.ts";

export default browserProject("extension", new URL(".", import.meta.url));

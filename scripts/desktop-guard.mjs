// The desktop layer drives Chrome's own windows with xdotool and scrot, which only the test container has.
if (process.env.RECNRUN_TEST_CONTAINER !== "1") {
  console.error(
    "tests/desktop runs only inside the Docker test container: use `vp run test:desktop`. The host has no isolated display, no xdotool, and no scrot, and the suite would drive a Chrome of this machine.",
  );
  process.exit(1);
}
if (!process.env.DISPLAY) {
  console.error("tests/desktop needs the container's Xvfb display, but DISPLAY is not set.");
  process.exit(1);
}

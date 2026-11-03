import { pocEnabled } from "@/config/origins";
import { startPocFileRead } from "@/offscreen/poc-file-read";
import { startOffscreen } from "@/offscreen/start";

startOffscreen();
if (pocEnabled(import.meta.env.MODE)) startPocFileRead();

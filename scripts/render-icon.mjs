// Renders assets/icon.svg → assets/icon.png (256×256).
// The Marketplace requires a PNG icon (SVG is rejected).
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const svg = join(root, "assets/icon.svg");
const png = join(root, "assets/icon.png");

await sharp(svg, { density: 300 }).resize(256, 256).png().toFile(png);
console.log(`icon rendered: ${png}`);

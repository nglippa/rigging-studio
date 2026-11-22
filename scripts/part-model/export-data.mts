// Export each labelled bench character as training data: RGBA image + 8-bit label map (0 bg, 1..14 BODY_PARTS, 255 equipment).
import { copyFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { loadImage, readTruth, truthLabels, truthNames, BODY_PARTS } from "../cut-bench.mjs";
for (const name of truthNames()) {
  const truth = readTruth(name); const image = loadImage(truth.image); const labels = truthLabels(truth, image);
  const png = new PNG({ width: image.width, height: image.height }); for (let i = 0; i < labels.length; i++) { png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = labels[i]; png.data[i * 4 + 3] = 255; }
  writeFileSync(`.bench/train/${name}.lab.png`, PNG.sync.write(png)); copyFileSync(truth.image, `.bench/train/${name}.png`);
}
writeFileSync(".bench/train/classes.json", JSON.stringify(BODY_PARTS));
console.log("exported", truthNames().length);

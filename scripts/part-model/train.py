# The part model (src/part-cutter/partModel.ts): a U-Net with a pretrained ResNet-34 encoder, trained on the hand-labelled
# cut bench (tests/fixtures/rigging/part-truth), run locally on the Mac's GPU. Data first: npm run part-model:data.
#   python train.py <run> <iters> <train names,comma | all> <test names,comma | -> [--export public/models/partseg/partseg.onnx]
# Writes .bench/train/<run>/model.pt and predictions for the test names; --export also writes the ONNX file the app and the
# bench load. Classes: 0 background, 1..14 BODY_PARTS (cut-bench order), 15 equipment. Left/right are SCREEN sides; a
# mirror swaps them. Augmentation: scale, position, small rotation, mirror, a hue shift for the whole figure and a separate
# random recolouring of each part, so the model learns shapes and placement rather than one character's colours.
import sys, os, json, math, random, time, numpy as np, torch, torch.nn.functional as F
from PIL import Image
import segmentation_models_pytorch as smp

args = [a for a in sys.argv[1:] if not a.startswith("--")]; export = sys.argv[sys.argv.index("--export") + 1] if "--export" in sys.argv else None
if export: args.remove(export)
run, iters = args[0], int(args[1])
ALL = sorted(n[:-8] for n in os.listdir(".bench/train") if n.endswith(".lab.png"))
train_names = ALL if args[2] == "all" else args[2].split(","); test_names = [] if args[3] == "-" else args[3].split(",")
D = ".bench/train"; OUT = f"{D}/{run}"; os.makedirs(f"{OUT}/pred", exist_ok=True)
S = 512; NC = 16
SWAP = np.arange(256, dtype=np.int64); SWAP[255] = 15
for a, b in [(3, 6), (4, 7), (5, 8), (9, 12), (10, 13), (11, 14)]: SWAP[a], SWAP[b] = b, a
REMAP = np.arange(256, dtype=np.int64); REMAP[255] = 15
dev = torch.device("mps") if torch.backends.mps.is_available() else torch.device("cpu")
SEED = int(os.environ.get("PART_SEED", "0"))  # another seed measures run-to-run variance
torch.manual_seed(SEED); random.seed(SEED); np.random.seed(SEED)

def load(name):
    img = np.array(Image.open(f"{D}/{name}.png").convert("RGBA")); lab = np.array(Image.open(f"{D}/{name}.lab.png"))[..., 0].astype(np.int64)
    lab = REMAP[lab]; lab[img[..., 3] <= 16] = 0
    ys, xs = np.nonzero(img[..., 3] > 16); return img, lab, (ys.min(), ys.max(), xs.min(), xs.max())

DATA = {n: load(n) for n in set(train_names + test_names)}

def rgb_to_hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]; mx = rgb.max(-1); mn = rgb.min(-1); d = mx - mn + 1e-6
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6.0
    s = np.where(mx > 0, (mx - mn) / (mx + 1e-6), 0); return np.stack([h, s, mx], -1)

def hsv_to_rgb(hsv):
    h, s, v = hsv[..., 0] * 6, hsv[..., 1], hsv[..., 2]; i = np.floor(h).astype(int) % 6; f = h - np.floor(h)
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    out = np.zeros(h.shape + (3,))
    for k, (a, b, c) in enumerate([(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]):
        m = i == k; out[m, 0], out[m, 1], out[m, 2] = a[m], b[m], c[m]
    return out

def place(img, lab, box, height, cx, cy, angle=0.0, flip=False):
    """Figure scaled to `height` px, centred at (cx, cy) on an SxS canvas (inverse-mapped, nearest)."""
    y0, y1, x0, x1 = box; fh = y1 - y0 + 1; sc = height / fh; ox, oy = (x0 + x1) / 2, (y0 + y1) / 2
    gy, gx = np.mgrid[0:S, 0:S].astype(np.float32); dx, dy = gx - cx, gy - cy
    ca, sa = math.cos(angle), math.sin(angle); rx, ry = (ca * dx + sa * dy) / sc, (-sa * dx + ca * dy) / sc
    if flip: rx = -rx
    sx = np.round(ox + rx).astype(int); sy = np.round(oy + ry).astype(int)
    ok = (sx >= 0) & (sy >= 0) & (sx < img.shape[1]) & (sy < img.shape[0])
    o_img = np.zeros((S, S, 4), np.float32); o_lab = np.zeros((S, S), np.int64)
    o_img[ok] = img[sy[ok], sx[ok]] / 255.0; o_lab[ok] = lab[sy[ok], sx[ok]]
    if flip: o_lab = SWAP[o_lab]
    return o_img, o_lab

def sample(name):
    img, lab, box = DATA[name]; flip = random.random() < .5
    o_img, o_lab = place(img, lab, box, random.uniform(330, 480), random.uniform(200, 312), random.uniform(230, 282), random.uniform(-.14, .14), flip)
    rgb = o_img[..., :3]; a = o_img[..., 3:4]
    hsv = rgb_to_hsv(rgb); hsv[..., 0] = (hsv[..., 0] + random.random()) % 1.0   # global hue
    for c in np.unique(o_lab):                                                     # each part recoloured on its own
        if c == 0 or random.random() < .3: continue
        m = o_lab == c; hsv[m, 0] = (hsv[m, 0] + random.uniform(-.5, .5)) % 1.0; hsv[m, 1] = np.clip(hsv[m, 1] * random.uniform(.6, 1.3), 0, 1); hsv[m, 2] = np.clip(hsv[m, 2] * random.uniform(.75, 1.2), 0, 1)
    rgb = hsv_to_rgb(hsv) * a
    x = np.concatenate([rgb, a], -1).transpose(2, 0, 1).astype(np.float32)
    return torch.from_numpy(x), torch.from_numpy(o_lab)

model = smp.Unet("resnet34", encoder_weights="imagenet", in_channels=4, classes=NC).to(dev)
opt = torch.optim.AdamW(model.parameters(), lr=3e-4, weight_decay=1e-4)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-4, total_steps=iters, pct_start=.1)
t0 = time.time(); B = 6
for it in range(iters):
    batch = [sample(random.choice(train_names)) for _ in range(B)]
    x = torch.stack([b[0] for b in batch]).to(dev); y = torch.stack([b[1] for b in batch]).to(dev)
    model.train(); logits = model(x); loss = F.cross_entropy(logits, y)
    opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    if it % 200 == 0 or it == iters - 1: print(f"it {it} loss {loss.item():.3f} {time.time() - t0:.0f}s", flush=True)
torch.save(model.state_dict(), f"{OUT}/model.pt")

@torch.inference_mode()
def predict(name):
    img, lab, box = DATA[name]; H, W = lab.shape; y0, y1, x0, x1 = box; fh = y1 - y0 + 1; height = 440; sc = height / fh
    probs = 0
    for flip in (False, True):
        o_img, _ = place(img, lab, box, height, S / 2, S / 2, 0, flip)
        x = torch.from_numpy(np.concatenate([o_img[..., :3] * o_img[..., 3:4], o_img[..., 3:4]], -1).transpose(2, 0, 1)[None].astype(np.float32)).to(dev)
        p = torch.softmax(model.eval()(x), 1)[0].cpu().numpy()
        if flip: p = p[SWAP[:NC]][:, :, ::-1]
        probs = probs + p / 2
    # back to source pixels: source (sx, sy) -> canvas (S/2 + (sx-ox)*sc, S/2 + (sy-oy)*sc)
    ox, oy = (x0 + x1) / 2, (y0 + y1) / 2; gy, gx = np.mgrid[0:H, 0:W]
    cx = np.clip(np.round(S / 2 + (gx - ox) * sc).astype(int), 0, S - 1); cy = np.clip(np.round(S / 2 + (gy - oy) * sc).astype(int), 0, S - 1)
    pp = probs[:, cy, cx]; out = pp.argmax(0); conf = pp.max(0)
    out[img[..., 3] <= 16] = 0; out8 = np.where(out == 15, 255, out).astype(np.uint8)
    Image.fromarray(out8).save(f"{OUT}/pred/{name}.lab.png"); Image.fromarray((conf * 255).astype(np.uint8)).save(f"{OUT}/pred/{name}.conf.png")
    m = (lab > 0) & (lab < 15); return float((out[m] == lab[m]).mean())

for n in test_names: print(f"test {n} raw pixel accuracy {predict(n) * 100:.1f}", flush=True)

if export:
    # Fixed batch of two (as drawn and mirrored), the input partModel.ts prepares.
    os.makedirs(os.path.dirname(export), exist_ok=True); cpu = model.to("cpu").eval()
    torch.onnx.export(cpu, torch.zeros(2, 4, S, S), export, input_names=["input"], output_names=["logits"], opset_version=17, dynamo=False)
    print("exported", export, os.path.getsize(export) // 1_000_000, "MB", flush=True)

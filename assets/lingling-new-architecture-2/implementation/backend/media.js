import fs from "node:fs";
import path from "node:path";
import { createId } from "./database.js";

const EXT_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
};

export function ensureMediaRoot(mediaRoot) {
  fs.mkdirSync(path.join(mediaRoot, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(mediaRoot, "generated"), { recursive: true });
  fs.mkdirSync(path.join(mediaRoot, "models"), { recursive: true });
}

export function saveUploadedFiles(files, mediaRoot) {
  ensureMediaRoot(mediaRoot);
  return files.map((file) => {
    const id = createId("upload");
    const ext =
      EXT_BY_MIME[file.mimetype] ||
      path.extname(file.originalname || "").toLowerCase() ||
      ".bin";
    const fileName = `${id}${ext}`;
    const diskPath = path.join(mediaRoot, "uploads", fileName);
    fs.writeFileSync(diskPath, file.buffer);
    return {
      id,
      originalName: file.originalname || fileName,
      mimeType: file.mimetype || "application/octet-stream",
      sizeBytes: file.size ?? file.buffer?.length ?? 0,
      url: `/media/uploads/${fileName}`,
    };
  });
}

export function saveGeneratedBase64(base64, mediaRoot, folder = "generated") {
  ensureMediaRoot(mediaRoot);
  const id = createId(folder === "models" ? "model-image" : "generated");
  const fileName = `${id}.png`;
  const diskPath = path.join(mediaRoot, folder, fileName);
  fs.writeFileSync(diskPath, Buffer.from(base64, "base64"));
  return { id, url: `/media/${folder}/${fileName}` };
}

import { Router, raw } from "express";
import {
  deleteJobIcon,
  jobIconDataUrl,
  jobIconDir,
  listJobIcons,
  saveJobIcon,
  MAX_ICON_BYTES,
} from "../jobs/jobIcons";

// The custom icons an operator has uploaded, for the picker and for every list that draws
// a job. They go out as data URLs rather than file URLs: this router sits behind requireAuth,
// which reads the Authorization header, and an <img> cannot send one.

const router = Router();

// GET / -- every uploaded icon, ready to render
router.get("/", (_req, res) => {
  const icons = listJobIcons().flatMap((file) => {
    const dataUrl = jobIconDataUrl(file);
    return dataUrl ? [{ name: file.name, size: file.size, dataUrl }] : [];
  });
  res.json({ dir: jobIconDir(), icons });
});

// POST / -- upload one icon; the body is the raw image bytes
router.post("/", raw({ type: () => true, limit: MAX_ICON_BYTES }), (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) {
    res.status(400).json({ error: "Image body is required" });
    return;
  }
  try {
    const file = saveJobIcon(body);
    res.status(201).json({
      name: file.name,
      size: file.size,
      dataUrl: jobIconDataUrl(file),
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid icon" });
  }
});

// DELETE /:name -- remove an uploaded icon. Jobs still pointing at it fall back to the
// default glyph, which is why isKnownIcon checks the file is there rather than trusting
// the stored reference.
router.delete("/:name", (req, res) => {
  res.json({ deleted: deleteJobIcon(req.params.name) });
});

export default router;

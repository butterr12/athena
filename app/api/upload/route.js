// app/api/upload/route.js
import { NextResponse } from "next/server";
import multer from "multer";
import fs from "fs";
import path from "path";
import { createRouter } from "next-connect";

const uploadFolder = path.join(process.cwd(), "public/uploads");
if (!fs.existsSync(uploadFolder)) fs.mkdirSync(uploadFolder);

const storage = multer.diskStorage({
  destination: uploadFolder,
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}_${file.originalname}`),
});

const upload = multer({ storage });

const router = createRouter({
  onError(err) {
    throw err;
  },
});

router.use(upload.single("image"));

export async function POST(req) {
  return new Promise((resolve, reject) => {
    router.run(req, {}, (err) => {
      if (err) {
        reject(
          NextResponse.json({ error: err.message }, { status: 500 })
        );
        return;
      }

      if (!req.file) {
        resolve(
          NextResponse.json({ error: "No file uploaded" }, { status: 400 })
        );
        return;
      }

      resolve(
        NextResponse.json({
          success: true,
          file: req.file.filename,
        })
      );
    });
  });
}

// app/api/images/route.js
import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

export async function GET() {
  const dir = path.join(process.cwd(), "public/uploads");
  if (!fs.existsSync(dir)) {
    return NextResponse.json(null);
  }

  const files = fs.readdirSync(dir)
    .map(f => ({
      name: f,
      time: fs.statSync(path.join(dir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time);

  return NextResponse.json(files[0]?.name ?? null);
}

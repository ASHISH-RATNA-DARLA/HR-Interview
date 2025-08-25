// app/api/save-metrics/route.ts
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const REPORTS_DIR = path.join(process.cwd(), "public", "reports");
const REPORT_FILE = "report.json";
const TMP_FILE = REPORT_FILE + ".tmp";

export async function GET() {
  try {
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    const filePath = path.join(REPORTS_DIR, REPORT_FILE);
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);

    return NextResponse.json({
      ok: true,
      files: exists ? [REPORT_FILE] : [],
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    const body = await req.json();

    const tmp = path.join(REPORTS_DIR, TMP_FILE);
    const final = path.join(REPORTS_DIR, REPORT_FILE);

    // Atomic write: write to tmp, then rename to final
    const payload = JSON.stringify(body, null, 2);
    await fs.writeFile(tmp, payload, "utf-8");
    await fs.rename(tmp, final);

    return NextResponse.json({
      ok: true,
      file: REPORT_FILE,
      publicPath: `/reports/${REPORT_FILE}`,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}

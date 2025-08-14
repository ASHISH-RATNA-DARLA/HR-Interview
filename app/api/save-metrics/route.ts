// app/api/save-metrics/route.ts
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const REPORTS_DIR = path.join(process.cwd(), "public", "reports");
const REPORT_FILE = "report.json";

export async function GET() {
  try {
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    const filePath = path.join(REPORTS_DIR, REPORT_FILE);
    const exists = await fs
      .access(filePath)
      .then(() => {
        console.log(`[API/save-metrics GET] report.json exists at ${filePath}`);
        return true;
      })
      .catch((err) => {
        console.warn(`[API/save-metrics GET] report.json does not exist at ${filePath}:`, err.message);
        return false;
      });

    return NextResponse.json({
      ok: true,
      files: exists ? [REPORT_FILE] : [],
    });
  } catch (e: any) {
    console.error("[API/save-metrics GET] Error:", e);
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

    const fullPath = path.join(REPORTS_DIR, REPORT_FILE);
    await fs.writeFile(fullPath, JSON.stringify(body, null, 2), "utf-8");

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

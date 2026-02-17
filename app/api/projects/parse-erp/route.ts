import { NextRequest, NextResponse } from "next/server";
import { parseErpCsv } from "@/lib/parseErp";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { csvText } = body as { csvText?: string };

    if (!csvText || !csvText.trim()) {
      return NextResponse.json(
        { error: "CSV text is required." },
        { status: 400 }
      );
    }

    const result = parseErpCsv(csvText);

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }
}

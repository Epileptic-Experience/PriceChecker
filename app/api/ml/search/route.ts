import { NextResponse } from "next/server";

export async function GET() {

  const BASE_URL = process.env.BASE_URL
  try {
    const res = await fetch(`${BASE_URL}/scrape`)
    const json = await res.json()

    const data = {
      results: json.results // o json.resultts según tu backend
    };


    return NextResponse.json(data);

    return data
  } catch (error: any) {
    return { "error:": error, "status:": error.status }
  }
}
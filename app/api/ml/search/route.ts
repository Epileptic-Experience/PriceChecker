import axios from "axios";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  console.log("entro route");

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");

  if (!query) {
    return NextResponse.json({ error: "Falta el parametro q" }, { status: 400 });
  }

  try {
    const res = await axios.get("https://api.mercadolibre.com/sites/MLA/search", {
      params: {
        q: query,
        limit: 200,
      },
      headers: {
        "user-agent": "Mozilla/5.0",
      },
    });

    return NextResponse.json(res.data.results);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 502;
      const details = {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        url: error.config?.url,
        params: error.config?.params,
      };

      console.error("Ocurrio un error al buscar en Mercado Libre", {
        query,
        ...details,
      });

      return NextResponse.json(
        {
          error: "Ocurrio un error al buscar",
          details,
        },
        { status }
      );
    } else {
      console.error("Ocurrio un error inesperado al buscar", {
        query,
        error,
      });

      return NextResponse.json(
        {
          error: "Ocurrio un error inesperado al buscar",
          details: String(error),
        },
        { status: 500 }
      );
    }
  }
}

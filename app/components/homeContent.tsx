"use client";

import { useState } from "react";

type ResultadoItem = {
  titulo: string;
  precio: number | string;
  oportunidad?: boolean;
  enlace: string;
};

type ResultadoGrupo = {
  producto: string;
  promedio: number | string;
  minimo: number | string;
  cantidad: number;
  items: ResultadoItem[];
};

export default function Home() {
  const [resultadosFront, setResultadosFront] = useState<ResultadoGrupo[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);


  const handleFetch = async () => {
    setLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/ml/search");

      const data = await res.json();

      setResultadosFront(data.results as ResultadoGrupo[]);
    } catch (error) {
      console.error("Error:", error);
      setResultadosFront([]);
      setErrorMessage(
        error instanceof Error ? error.message : "Error inesperado al cargar datos."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: "20px" }}>
      <button onClick={handleFetch}>
        {loading ? "Cargando..." : "Scrapear"}
      </button>

      {errorMessage && (
        <p style={{ marginTop: "12px", color: "crimson" }}>{errorMessage}</p>
      )}

      <div className="d-flex justify-content-center flex-column align-items-center text-center" style={{ marginTop: "20px" }}>
        {resultadosFront.map((grupo, index) => (
          <div key={index} className="d-flex flex-column text-center p-5 w-100" style={{ marginBottom: "20px", border:"2px solid white", borderRadius:"8px" }}>
            <h2>{grupo.producto}</h2>
            <p>💰 Promedio: {grupo.promedio}</p>
            <p>💸 Mínimo: {grupo.minimo}</p>
            <p>📦 Cantidad: {grupo.cantidad}</p>

            <div>
              {grupo.items.map((item, i: number) => (
                <div key={i} className="d-flex text-center justify-content-center" style={{ marginBottom: "10px" }}>
                  <p>{item.titulo}</p>
                  <p>
                    💵 {item.precio}{" "}
                    {item.oportunidad && "🔥 OPORTUNIDAD"}
                  </p>
                  <a href={item.enlace} target="_blank">
                    Ver producto
                  </a>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

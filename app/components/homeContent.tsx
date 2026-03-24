"use client"
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import axios from "axios";


export default function Home() {
  const [query, setQuery] = useState<string>("")
  const [results, setResults] = useState<any[]>([])
  const searchParams = useSearchParams();
  const code = searchParams.get("code");


  const handleAuth = async () => {
    try {
      const res = axios.post("/api/ml/auth", { code });
      console.log(code, "CODE")
      console.log(res, "RES");

    } catch (error) {
      console.log(error, "error al autorizar");
    }
  };

  useEffect(() => {
    if (code && code !== "") {
      handleAuth()
    }
  }, [code])

  const handleSearch = async () => {
    const res = await fetch(`/api/ml/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) {
      console.error("Fallo la busqueda", data);
      return;
    }
    setResults(data);
  };

  const handleLogin = () => {
    const client_id = process.env.NEXT_PUBLIC_CLIENT_ID;
    const redirect_uri = process.env.NEXT_PUBLIC_REDIRECT_URI;
    const url = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${client_id}&redirect_uri=${redirect_uri}`;

    window.location.href = url;
  };

  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <button onClick={handleLogin}>Conectar MercadoLibre</button>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar"
      />

      <button onClick={handleSearch}>Buscar</button>

      <div>
        {results.map((item, idx) => (
          <div key={idx}>
            {item.title}
          </div>
        ))}
      </div>
    </div>
  );
}
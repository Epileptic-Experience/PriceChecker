"use client"
import { useEffect, useState } from "react";
// import { getProducts } from "@/api/ml/search/route";

export default function Home() {
  const [query, setQuery] = useState<string>("")
  const [results, setResults] = useState<any[]>([])

const handleSearch = async () => {
  console.log("entro funcion")
  const res = await fetch(`/api/ml/search?q=${encodeURIComponent(query)}`);
  const data = await res.json();

  if (!res.ok) {
    console.error("Fallo la busqueda", {
      status: res.status,
      data,
    });
    return;
  }

  setResults(data);
};

  // useEffect(()=>{
  //   console.log(results,"RESULTADOS" )
  // },[results])
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value) }}
        type="text"
        placeholder="Buscar" />
      <button onClick={()=>handleSearch()}>Buscar</button>
    </div>
  );
}

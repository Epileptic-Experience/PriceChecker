"use client";

import { Suspense } from "react";
import HomeContent from "./components/homeContent";

export default function Page() {
  return (
    <Suspense fallback={<div>Cargando...</div>}>
      <HomeContent />
    </Suspense>
  );
}

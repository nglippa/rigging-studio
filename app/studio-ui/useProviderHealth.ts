"use client";

import { useEffect, useMemo, useState } from "react";
import { getProviderHealthService, type ProviderHealthSnapshot } from "@/src/local-services/providerHealth";

export function useProviderHealth(): { readonly health: ProviderHealthSnapshot; readonly retry: () => Promise<ProviderHealthSnapshot>; readonly reportFailure: (error: unknown) => void } {
  const service = useMemo(() => getProviderHealthService(), []);
  const [health, setHealth] = useState(service.snapshot);
  useEffect(() => service.subscribe(() => setHealth(service.snapshot)), [service]);
  return { health, retry: () => service.retry(), reportFailure: (error) => service.reportJobFailure(error) };
}

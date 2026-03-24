type MlDebugDetails = Record<string, unknown>;

function parseDebugValue(value: string | undefined | null) {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isMlDebugEnvEnabled() {
  // return parseDebugValue(process.env.ML_DEBUG);
  return true
}

export function isMlDebugEnabled(request?: Request) {
  if (isMlDebugEnvEnabled()) {
    return true;
  }

  if (!request) {
    return false;
  }

  try {
    const url = new URL(request.url);
    return parseDebugValue(url.searchParams.get("debug"));
  } catch {
    return false;
  }
}

export function createMlTraceId(prefix = "ml") {
  const randomPart = Math.random().toString(36).slice(2, 8);
  const timePart = Date.now().toString(36);
  return `${prefix}-${timePart}-${randomPart}`;
}

export function logMlStep(params: {
  enabled: boolean;
  route: string;
  traceId: string;
  step: string;
  details?: MlDebugDetails;
}) {
  if (!params.enabled) {
    return;
  }

  const timestamp = new Date().toISOString();
  const prefix = `[ML DEBUG] ${timestamp} [${params.route}] [${params.traceId}] ${params.step}`;

  if (params.details && Object.keys(params.details).length > 0) {
    console.log(prefix, params.details);
    return;
  }

  console.log(prefix);
}

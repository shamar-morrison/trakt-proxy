type SearchParamValue = string | string[] | undefined;

interface TraktErrorPageProps {
  searchParams?: {
    error?: SearchParamValue;
    reason?: SearchParamValue;
    ray?: SearchParamValue;
  };
}

function firstParam(value: SearchParamValue): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function getErrorCopy(reason: string | undefined) {
  switch (reason) {
    case "upstream_blocked":
      return {
        title: "Connection Temporarily Blocked",
        description:
          "Trakt's upstream security blocked this token exchange request. Please try again shortly from the app.",
      };
    case "invalid_oauth":
      return {
        title: "Authorization Could Not Be Verified",
        description:
          "The authorization callback could not be validated. Start the Trakt connection flow again from the app.",
      };
    case "upstream_unavailable":
      return {
        title: "Trakt Is Temporarily Unavailable",
        description:
          "Trakt could not be reached from the backend right now. Please try connecting again in a few minutes.",
      };
    default:
      return {
        title: "Unable to Connect Trakt",
        description:
          "The backend could not complete Trakt authorization. Please retry from the app.",
      };
  }
}

export default function TraktErrorPage({ searchParams }: TraktErrorPageProps) {
  const error = firstParam(searchParams?.error);
  const reason = firstParam(searchParams?.reason);
  const ray = firstParam(searchParams?.ray);
  const copy = getErrorCopy(reason);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0d0d0d",
        color: "#ffffff",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: "80px",
          height: "80px",
          borderRadius: "50%",
          backgroundColor: "#ef4444",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: "1.5rem",
        }}
      >
        <svg
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </div>

      <h1
        style={{
          fontSize: "1.75rem",
          fontWeight: "700",
          marginBottom: "0.75rem",
          color: "#ffffff",
        }}
      >
        {copy.title}
      </h1>

      <p
        style={{
          fontSize: "1rem",
          color: "#a1a1aa",
          maxWidth: "360px",
          lineHeight: "1.5",
          marginBottom: "1rem",
        }}
      >
        {copy.description}
      </p>

      <p
        style={{
          fontSize: "0.95rem",
          color: "#d4d4d8",
          maxWidth: "360px",
          lineHeight: "1.5",
          marginBottom: "2rem",
        }}
      >
        Return to the app, retry Trakt sync, and contact support if this keeps
        happening.
      </p>

      <div
        style={{
          width: "100%",
          maxWidth: "420px",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "0.75rem 1rem",
          textAlign: "left",
          color: "#d4d4d8",
          fontSize: "0.85rem",
          backgroundColor: "#111111",
        }}
      >
        <div>
          <strong>Error:</strong> {error || "unknown"}
        </div>
        <div>
          <strong>Reason:</strong> {reason || "unknown"}
        </div>
        {ray ? (
          <div>
            <strong>Ray ID:</strong> {ray}
          </div>
        ) : null}
      </div>
    </div>
  );
}

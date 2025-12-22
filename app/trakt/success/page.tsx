"use client";

export default function TraktSuccessPage() {
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
      {/* Success Icon */}
      <div
        style={{
          width: "80px",
          height: "80px",
          borderRadius: "50%",
          backgroundColor: "#22c55e",
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
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>

      {/* Title */}
      <h1
        style={{
          fontSize: "1.75rem",
          fontWeight: "700",
          marginBottom: "0.75rem",
          color: "#ffffff",
        }}
      >
        Successfully Connected!
      </h1>

      {/* Description */}
      <p
        style={{
          fontSize: "1rem",
          color: "#a1a1aa",
          maxWidth: "320px",
          lineHeight: "1.5",
          marginBottom: "2rem",
        }}
      >
        Your Trakt account has been linked. You can now close this page and
        return to the app.
      </p>

      {/* Trakt Logo */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          color: "#ed1c24",
          fontSize: "0.875rem",
          fontWeight: "500",
        }}
      >
        <span>Powered by</span>
        <img src="/trakt.svg" alt="Trakt Logo" width={60} height={60} />
      </div>
    </div>
  );
}
